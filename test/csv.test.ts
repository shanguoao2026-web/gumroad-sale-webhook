import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csvField, csvLine, parseCsv } from '../src/csv.js';
import { Ledger, ledgerColumn, LEDGER_COLUMNS } from '../src/ledger.js';
import { dedupeKey, type StoredRecord } from '../src/types.js';
import { makeTempDir, removeTemp } from './helpers.js';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

function sample(overrides: Partial<StoredRecord> = {}): StoredRecord {
  const saleId = overrides.sale_id ?? 'sale_fieldnotes_1001';
  const resource = overrides.resource_name ?? 'sale';
  return {
    dedupe_key: dedupeKey(resource, saleId),
    received_at: '2026-04-12T15:04:05.000Z',
    sale_id: saleId,
    resource_name: resource,
    email: 'ada.quill@example.com',
    full_name: 'Ada Quill',
    seller_id: 'seller_nwp_01',
    product_id: 'prod_fieldnotes',
    short_product_id: 'nfnotes',
    product_name: 'Northwind Field Notes',
    product_permalink: 'https://example.com/l/northwind-field-notes',
    price_cents: 1800,
    gumroad_fee_cents: 230,
    currency: 'usd',
    quantity: 1,
    order_number: '100391',
    sale_timestamp: '2026-04-12T15:04:05Z',
    refunded: resource === 'refund',
    test: false,
    ip_country: 'US',
    recurrence: '',
    can_contact: true,
    discover_fee_charged: false,
    email_file: `outbox/${resource}--${saleId}.eml`,
    email_skipped_reason: null,
    ...overrides,
  };
}

describe('csv', () => {
  it('quotes commas, quotes, and newlines', () => {
    assert.equal(csvField('Ada, Quill'), '"Ada, Quill"');
    assert.equal(csvField('say "hi"'), '"say ""hi"""');
    assert.deepEqual(parseCsv('a,"b,c",d\n'), [['a', 'b,c', 'd']]);
    assert.equal(parseCsv('"say ""hi"""\n')[0]?.[0], 'say "hi"');
  });

  it('neutralizes formula text and keeps negative integers numeric', () => {
    const hostile = '=HYPERLINK("http://evil.test","x")';
    const cell = csvField(hostile);
    assert.equal(cell.startsWith(`"'`), true);
    assert.equal(parseCsv(`${cell}\n`)[0]?.[0]?.startsWith("'="), true);
    assert.equal(csvField(-1800), '-1800');
    assert.equal(csvLine(['sale:sale_1', -1800, null, false]), 'sale:sale_1,-1800,,false');
  });

  it('rejects an unterminated quote', () => {
    assert.throws(() => parseCsv('"open'), /unterminated quote/);
  });
});

describe('ledger', () => {
  it('writes one header and a negative signed amount for a refund', async () => {
    const dir = await makeTempDir();
    try {
      const ledger = new Ledger(join(dir, 'ledger.csv'));
      await ledger.load();
      const sale = sample();
      const refund = sample({
        resource_name: 'refund',
        refunded: true,
        email_file: 'outbox/refund--sale_fieldnotes_1001.eml',
      });
      assert.equal(await ledger.append(sale), true);
      assert.equal(await ledger.append(sale), false);
      assert.equal(await ledger.append(refund), true);
      const text = await readFile(join(dir, 'ledger.csv'), 'utf8');
      const rows = parseCsv(text);
      assert.equal(rows[0]?.join(','), LEDGER_COLUMNS.join(','));
      assert.equal(rows.length, 3);
      const signed = ledgerColumn('signed_cents');
      assert.equal(rows[1]?.[signed], '1800');
      assert.equal(rows[2]?.[signed], '-1800');
      const reloaded = new Ledger(join(dir, 'ledger.csv'));
      await reloaded.load();
      assert.equal(reloaded.size(), 2);
      assert.equal(reloaded.has(sale.dedupe_key), true);
    } finally {
      await removeTemp(dir);
    }
  });

  it('quotes a hostile product name and reloads the dedupe key', async () => {
    const dir = await makeTempDir();
    try {
      const ledger = new Ledger(join(dir, 'ledger.csv'));
      await ledger.load();
      const record = sample({ product_name: '=HYPERLINK("http://evil.test","x")' });
      await ledger.append(record);
      const rows = parseCsv(await readFile(join(dir, 'ledger.csv'), 'utf8'));
      assert.equal(rows[1]?.[0], record.dedupe_key);
      const name = rows[1]?.[ledgerColumn('product_name')] ?? '';
      assert.equal(name.startsWith("'="), true);
      assert.equal(name.includes('HYPERLINK'), true);
    } finally {
      await removeTemp(dir);
    }
  });

  it('refuses a corrupt header', async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, 'ledger.csv'), 'nope\n', 'utf8');
      const ledger = new Ledger(join(dir, 'ledger.csv'));
      await assert.rejects(ledger.load(), /corrupt/);
    } finally {
      await removeTemp(dir);
    }
  });
});
