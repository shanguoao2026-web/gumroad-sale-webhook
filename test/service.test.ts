import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseCsv } from '../src/csv.js';
import { ledgerColumn } from '../src/ledger.js';
import { PingService } from '../src/service.js';
import { dedupeKey } from '../src/types.js';
import { DEFAULT_FROM } from '../src/limits.js';
import { makeTempDir, removeTemp, saleForm, templatesDir, withService } from './helpers.js';

describe('PingService', () => {
  it('stores a sale in jsonl, the ledger, and the outbox', async () => {
    await withService(async (service, dir) => {
      const result = await service.ingest(saleForm({ license_key: 'do-not-store-this-license', card: 'do-not-store-this-card-token' }));
      assert.equal(result.status, 'accepted');
      if (result.status !== 'accepted') {
        return;
      }
      assert.equal(result.record.dedupe_key, 'sale:sale_fieldnotes_1001');
      assert.equal(result.record.email_file, 'outbox/sale--sale_fieldnotes_1001.eml');
      const jsonl = await readFile(join(dir, 'events.jsonl'), 'utf8');
      assert.equal(jsonl.includes('do-not-store-this-license'), false);
      assert.equal(jsonl.includes('do-not-store-this-card-token'), false);
      const email = await readFile(join(dir, 'outbox', 'sale--sale_fieldnotes_1001.eml'), 'utf8');
      assert.match(email, /This message was not sent\./);
      const rows = parseCsv(await readFile(join(dir, 'ledger.csv'), 'utf8'));
      assert.equal(rows.length, 2);
      assert.equal(rows[1]?.[ledgerColumn('signed_cents')], '1800');
    });
  });

  it('collapses a duplicate delivery, including two in flight', async () => {
    await withService(async (service, dir) => {
      const body = saleForm();
      const [first, second] = await Promise.all([service.ingest(body), service.ingest(body)]);
      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, ['accepted', 'duplicate']);
      const third = await service.ingest(body);
      assert.equal(third.status, 'duplicate');
      if (third.status !== 'duplicate' || first.status === 'invalid' || second.status === 'invalid') {
        return;
      }
      const kept = first.status === 'accepted' ? first.record.received_at : second.record.received_at;
      assert.equal(third.record.received_at, kept);
      const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n');
      assert.equal(lines.length, 1);
      const rows = parseCsv(await readFile(join(dir, 'ledger.csv'), 'utf8'));
      assert.equal(rows.length, 2);
    });
  });

  it('keeps a refund of the same sale_id as its own event', async () => {
    await withService(async (service, dir) => {
      const sale = await service.ingest(saleForm());
      const refund = await service.ingest(saleForm({ resource_name: 'refund', refunded: 'true' }));
      assert.equal(sale.status, 'accepted');
      assert.equal(refund.status, 'accepted');
      assert.equal(service.count(), 2);
      const rows = parseCsv(await readFile(join(dir, 'ledger.csv'), 'utf8'));
      const signed = rows.slice(1).map((row) => Number(row[ledgerColumn('signed_cents')]));
      assert.equal(signed.reduce((sum, value) => sum + value, 0), 0);
      const refundMail = await readFile(join(dir, 'outbox', 'refund--sale_fieldnotes_1001.eml'), 'utf8');
      assert.match(refundMail, /Refund recorded/);
      assert.match(refundMail, /This message was not sent\./);
    });
  });

  it('skips the welcome email when the refund arrives first', async () => {
    await withService(async (service, dir) => {
      const refund = await service.ingest(saleForm({ resource_name: 'refund', refunded: 'true', sale_id: 'sale_lantern_1003' }));
      const sale = await service.ingest(saleForm({ sale_id: 'sale_lantern_1003', refunded: 'false' }));
      assert.equal(refund.status, 'accepted');
      assert.equal(sale.status, 'accepted');
      if (sale.status !== 'accepted') {
        return;
      }
      assert.equal(sale.record.email_file, null);
      assert.equal(sale.record.email_skipped_reason, 'refund_already_recorded');
      await assert.rejects(readFile(join(dir, 'outbox', 'sale--sale_lantern_1003.eml')));
      const refundMail = await readFile(join(dir, 'outbox', 'refund--sale_lantern_1003.eml'), 'utf8');
      assert.match(refundMail, /This message was not sent\./);
    });
  });

  it('skips the welcome email when the sale ping is already marked refunded', async () => {
    await withService(async (service) => {
      const sale = await service.ingest(saleForm({ refunded: 'true' }));
      assert.equal(sale.status, 'accepted');
      if (sale.status !== 'accepted') {
        return;
      }
      assert.equal(sale.record.email_skipped_reason, 'sale_marked_refunded');
      assert.equal(sale.record.email_file, null);
    });
  });

  it('marks a test ping in the subject and does not multiply price by quantity', async () => {
    await withService(async (service, dir) => {
      const result = await service.ingest(saleForm({ test: 'true', quantity: '2', price: '100', sale_id: 'sale_test_1004' }));
      assert.equal(result.status, 'accepted');
      const email = await readFile(join(dir, 'outbox', 'sale--sale_test_1004.eml'), 'utf8');
      assert.match(email, /Subject: \[test\] Your Northwind Field Notes is ready/);
      const rows = parseCsv(await readFile(join(dir, 'ledger.csv'), 'utf8'));
      assert.equal(rows[1]?.[ledgerColumn('signed_cents')], '100');
      assert.equal(rows[1]?.[ledgerColumn('quantity')], '2');
    });
  });

  it('writes nothing when validation fails', async () => {
    await withService(async (service, dir) => {
      const result = await service.ingest('email=not-an-email');
      assert.equal(result.status, 'invalid');
      assert.equal(service.count(), 0);
      await assert.rejects(readFile(join(dir, 'events.jsonl')));
      await assert.rejects(readFile(join(dir, 'ledger.csv')));
    });
  });

  it('restores missing ledger and email files from the jsonl log', async () => {
    const dir = await makeTempDir();
    try {
      const first = new PingService({ dataDir: dir, templatesDir: templatesDir(), from: DEFAULT_FROM });
      await first.init();
      await first.ingest(saleForm());
      await rm(join(dir, 'ledger.csv'));
      await rm(join(dir, 'outbox', 'sale--sale_fieldnotes_1001.eml'));
      const second = new PingService({ dataDir: dir, templatesDir: templatesDir(), from: DEFAULT_FROM });
      await second.init();
      const rows = parseCsv(await readFile(join(dir, 'ledger.csv'), 'utf8'));
      assert.equal(rows.length, 2);
      const email = await readFile(join(dir, 'outbox', 'sale--sale_fieldnotes_1001.eml'), 'utf8');
      assert.match(email, /sale_fieldnotes_1001/);
      const duplicate = await second.ingest(saleForm());
      assert.equal(duplicate.status, 'duplicate');
      assert.equal(second.count(), 1);
    } finally {
      await removeTemp(dir);
    }
  });

  it('rewrites a deleted outbox file when the duplicate ping arrives', async () => {
    await withService(async (service, dir) => {
      await service.ingest(saleForm());
      await rm(join(dir, 'outbox', 'sale--sale_fieldnotes_1001.eml'));
      const again = await service.ingest(saleForm());
      assert.equal(again.status, 'duplicate');
      if (again.status !== 'duplicate') {
        return;
      }
      assert.equal(again.healed, true);
      const email = await readFile(join(dir, 'outbox', 'sale--sale_fieldnotes_1001.eml'), 'utf8');
      assert.match(email, /This message was not sent\./);
      const rows = parseCsv(await readFile(join(dir, 'ledger.csv'), 'utf8'));
      assert.equal(rows.length, 2);
      assert.equal(service.list()[0]?.dedupe_key, dedupeKey('sale', 'sale_fieldnotes_1001'));
    });
  });
});
