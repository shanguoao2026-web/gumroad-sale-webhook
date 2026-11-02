import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_BODY_BYTES } from '../src/limits.js';
import type { Logger } from '../src/logger.js';
import { startServer, tokensMatch } from '../src/server.js';
import { makeTempDir, removeTemp, saleForm, TOKEN, withServer } from './helpers.js';

describe('tokensMatch', () => {
  it('accepts only the same secret', () => {
    assert.equal(tokensMatch(TOKEN, TOKEN), true);
    assert.equal(tokensMatch(TOKEN, `${TOKEN}x`), false);
    assert.equal(tokensMatch(TOKEN, TOKEN.slice(0, -1)), false);
    assert.equal(tokensMatch(TOKEN, ''), false);
    assert.equal(tokensMatch(TOKEN, 'x'.repeat(5000)), false);
  });
});

describe('HTTP server', () => {
  it('reports health without a token and without buyer data', async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/health`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.service, 'gumroad-sale-webhook');
      assert.match(String(body.version), /^\d+\.\d+\.\d+$/);
      assert.equal(body.events, 0);
      assert.equal(JSON.stringify(body).includes(TOKEN), false);
      assert.equal(JSON.stringify(body).includes('email'), false);
    });
  });

  it('accepts a sale, ignores a duplicate, and stores a refund', async () => {
    await withServer(async (base) => {
      const post = (body: string, token = TOKEN) =>
        fetch(`${base}/gumroad/ping?token=${token}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
          body,
        });
      const sale = await post(saleForm());
      assert.equal(sale.status, 200);
      const saleBody = (await sale.json()) as { duplicate: boolean; email_file: string };
      assert.equal(saleBody.duplicate, false);
      assert.equal(saleBody.email_file, 'outbox/sale--sale_fieldnotes_1001.eml');

      const again = await post(saleForm({ retry_count: '1' }));
      assert.equal(again.status, 200);
      const againBody = (await again.json()) as { duplicate: boolean };
      assert.equal(againBody.duplicate, true);

      const refund = await post(saleForm({ resource_name: 'refund', refunded: 'true' }));
      assert.equal(refund.status, 200);
      const refundBody = (await refund.json()) as { duplicate: boolean; resource_name: string };
      assert.equal(refundBody.duplicate, false);
      assert.equal(refundBody.resource_name, 'refund');

      const health = await fetch(`${base}/health/`);
      const healthBody = (await health.json()) as { events: number };
      assert.equal(healthBody.events, 2);
    });
  });

  it('rejects a missing token, a wrong token, and a token that is only in the body', async () => {
    await withServer(async (base) => {
      const missing = await fetch(`${base}/gumroad/ping`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: saleForm(),
      });
      assert.equal(missing.status, 403);
      const wrong = await fetch(`${base}/gumroad/ping?token=not-the-real-token-value`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: saleForm(),
      });
      assert.equal(wrong.status, 403);
      const hidden = await fetch(`${base}/gumroad/ping`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: saleForm({ token: TOKEN }),
      });
      assert.equal(hidden.status, 403);
      const health = await fetch(`${base}/health`);
      const body = (await health.json()) as { events: number };
      assert.equal(body.events, 0);
    });
  });

  it('rejects the wrong method, the wrong type, unknown paths, and invalid fields', async () => {
    await withServer(async (base) => {
      const getPing = await fetch(`${base}/gumroad/ping?token=${TOKEN}`);
      assert.equal(getPing.status, 405);
      assert.equal(getPing.headers.get('allow'), 'POST');

      const json = await fetch(`${base}/gumroad/ping?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(json.status, 415);

      const missingType = await fetch(`${base}/gumroad/ping?token=${TOKEN}`, {
        method: 'POST',
        body: saleForm(),
      });
      assert.equal(missingType.status, 415);

      const missing = await fetch(`${base}/nope`);
      assert.equal(missing.status, 404);

      const invalid = await fetch(`${base}/gumroad/ping/?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'price=10',
      });
      assert.equal(invalid.status, 422);
      const invalidBody = (await invalid.json()) as { error: string; fields: string[] };
      assert.equal(invalidBody.error, 'validation_failed');
      assert.ok(invalidBody.fields.includes('sale_id is required'));
    });
  });

  it('rejects an oversized body and invalid UTF-8', async () => {
    await withServer(async (base) => {
      const oversized = await fetch(`${base}/gumroad/ping?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: Buffer.alloc(MAX_BODY_BYTES + 1, 0x61),
      });
      assert.equal(oversized.status, 413);

      const badEncoding = await fetch(`${base}/gumroad/ping?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: Buffer.from([0xff, 0xfe, 0xfd]),
      });
      assert.equal(badEncoding.status, 400);
      const body = (await badEncoding.json()) as { error: string };
      assert.equal(body.error, 'invalid_encoding');
    });
  });

  it('hides internal errors from the response body', async () => {
    const dir = await makeTempDir();
    const errors: string[] = [];
    const logger: Logger = {
      info() {},
      error(message: string) {
        errors.push(message);
      },
    };
    const running = await startServer({
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      logger,
      service: {
        count: () => 0,
        ingest: () => Promise.reject(new Error('disk full on /secret/path')),
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${running.port}/gumroad/ping?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: saleForm(),
      });
      assert.equal(response.status, 500);
      const text = await response.text();
      assert.equal(text.includes('disk full'), false);
      assert.equal(text.includes('/secret/path'), false);
      assert.ok(errors.some((line) => line.includes('disk full')));
    } finally {
      await running.close();
      await removeTemp(dir);
    }
  });

});
