import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseCsv } from '../src/csv.js';
import { ledgerColumn } from '../src/ledger.js';
import { DEFAULT_FROM } from '../src/limits.js';
import { exitCodeForReport, formatReport, listFixtures, replayHttp, replayLocal, withToken } from '../src/replay.js';
import { PingService } from '../src/service.js';
import { parsePingBody } from '../src/validate.js';
import { fixturesDir, makeTempDir, removeTemp, templatesDir, TOKEN, withServer } from './helpers.js';

async function localReplay(dir: string) {
  const service = new PingService({ dataDir: dir, templatesDir: templatesDir(), from: DEFAULT_FROM });
  await service.init();
  return { service, report: await replayLocal(service, fixturesDir()) };
}

describe('fixtures', () => {
  it('validates every shipped ping and rejects the invalid sample', async () => {
    const files = await listFixtures(fixturesDir());
    assert.equal(files.length, 7);
    for (const file of files) {
      const body = await readFile(file, 'utf8');
      const parsed = parsePingBody(body);
      assert.equal(parsed.ok, true, file);
    }
    const invalid = parsePingBody(await readFile(join(fixturesDir(), 'invalid', 'missing-sale-id.form'), 'utf8'));
    assert.equal(invalid.ok, false);
  });
});

describe('replay', () => {
  it('applies the fictional fixtures once and ignores a second pass', async () => {
    const dir = await makeTempDir();
    try {
      const first = await localReplay(dir);
      assert.equal(first.report.accepted, 6);
      assert.equal(first.report.duplicate, 1);
      assert.equal(first.report.rejected, 0);
      assert.equal(exitCodeForReport(first.report), 0);
      assert.match(formatReport(first.report), /01-sale-field-notes\.form/);
      assert.equal(first.service.count(), 6);

      const jsonl = await readFile(join(dir, 'events.jsonl'), 'utf8');
      assert.equal(jsonl.includes('do-not-store-this-license'), false);
      assert.equal(jsonl.includes('do-not-store-this-card-token'), false);

      const rows = parseCsv(await readFile(join(dir, 'ledger.csv'), 'utf8'));
      const signed = rows.slice(1).map((row) => Number(row[ledgerColumn('signed_cents')]));
      assert.equal(signed.reduce((sum, value) => sum + value, 0), 100);
      const testRow = rows.find((row) => row[ledgerColumn('sale_id')] === 'sale_test_1004');
      assert.equal(testRow?.[ledgerColumn('gumroad_fee_cents')], '');
      assert.equal(testRow?.[ledgerColumn('quantity')], '2');

      const outbox = (await readdir(join(dir, 'outbox'))).filter((name) => name.endsWith('.eml')).sort();
      assert.deepEqual(outbox, [
        'refund--sale_fieldnotes_1001.eml',
        'refund--sale_lantern_1003.eml',
        'sale--sale_checklist_1002.eml',
        'sale--sale_fieldnotes_1001.eml',
        'sale--sale_test_1004.eml',
      ]);
      const testMail = await readFile(join(dir, 'outbox', 'sale--sale_test_1004.eml'), 'utf8');
      assert.match(testMail, /\[test\]/);
      await assert.rejects(readFile(join(dir, 'outbox', 'sale--sale_lantern_1003.eml')));

      const second = await localReplay(dir);
      assert.equal(second.report.accepted, 0);
      assert.equal(second.report.duplicate, 7);
      assert.equal(second.service.count(), 6);
      const outboxAgain = (await readdir(join(dir, 'outbox'))).filter((name) => name.endsWith('.eml'));
      assert.equal(outboxAgain.length, 5);
    } finally {
      await removeTemp(dir);
    }
  });

  it('rejects an invalid fixture file and an empty directory', async () => {
    const dir = await makeTempDir();
    try {
      const service = new PingService({ dataDir: dir, templatesDir: templatesDir(), from: DEFAULT_FROM });
      await service.init();
      const report = await replayLocal(service, join(fixturesDir(), 'invalid', 'missing-sale-id.form'));
      assert.equal(report.rejected, 1);
      assert.equal(exitCodeForReport(report), 1);
      assert.equal(service.count(), 0);
      await assert.rejects(replayLocal(service, dir), /no fixtures found/);
    } finally {
      await removeTemp(dir);
    }
  });

  it('posts fixtures to a running server when given a URL', async () => {
    await withServer(async (base, dir) => {
      const endpoint = `${base}/gumroad/ping`;
      assert.throws(() => withToken('file:///tmp/pings', TOKEN), /http or https/);
      assert.equal(new URL(withToken(endpoint, TOKEN)).searchParams.get('token'), TOKEN);
      const report = await replayHttp(endpoint, fixturesDir(), TOKEN);
      assert.equal(report.accepted, 6);
      assert.equal(report.duplicate, 1);
      assert.equal(report.error, 0);
      const rows = parseCsv(await readFile(join(dir, 'ledger.csv'), 'utf8'));
      assert.equal(rows.length, 7);
    });
  });
});
