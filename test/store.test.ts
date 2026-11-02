import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EventStore } from '../src/store.js';
import { dedupeKey, type StoredRecord } from '../src/types.js';
import { makeTempDir, removeTemp } from './helpers.js';

function record(saleId = 'sale_fieldnotes_1001'): StoredRecord {
  return {
    dedupe_key: dedupeKey('sale', saleId),
    received_at: '2026-04-12T15:04:05.000Z',
    sale_id: saleId,
    resource_name: 'sale',
    email: 'ada.quill@example.com',
    full_name: 'Ada Quill',
    seller_id: 'seller_nwp_01',
    product_id: 'prod_fieldnotes',
    short_product_id: '',
    product_name: 'Northwind Field Notes',
    product_permalink: '',
    price_cents: 1800,
    gumroad_fee_cents: null,
    currency: 'usd',
    quantity: 1,
    order_number: '100391',
    sale_timestamp: '2026-04-12T15:04:05Z',
    refunded: false,
    test: false,
    ip_country: 'US',
    recurrence: '',
    can_contact: null,
    discover_fee_charged: null,
    email_file: `outbox/sale--${saleId}.eml`,
    email_skipped_reason: null,
  };
}

describe('EventStore', () => {
  it('appends and reloads records in order', async () => {
    const dir = await makeTempDir();
    try {
      const file = join(dir, 'events.jsonl');
      const store = new EventStore(file);
      await store.load();
      await store.append(record('sale_one'));
      await store.append(record('sale_two'));
      const reloaded = new EventStore(file);
      await reloaded.load();
      assert.deepEqual(
        reloaded.list().map((item) => item.sale_id),
        ['sale_one', 'sale_two'],
      );
      assert.equal(reloaded.has(dedupeKey('sale', 'sale_one')), true);
    } finally {
      await removeTemp(dir);
    }
  });

  it('treats a missing file as an empty store', async () => {
    const dir = await makeTempDir();
    try {
      const store = new EventStore(join(dir, 'missing.jsonl'));
      await store.load();
      assert.equal(store.size(), 0);
    } finally {
      await removeTemp(dir);
    }
  });

  it('rejects a duplicate key, corrupt JSON, and an escaping email path', async () => {
    const dir = await makeTempDir();
    try {
      const file = join(dir, 'events.jsonl');
      const first = record();
      await writeFile(file, `${JSON.stringify(first)}\n${JSON.stringify(first)}\n`, 'utf8');
      await assert.rejects(new EventStore(file).load(), /duplicates dedupe_key/);

      await writeFile(file, '{not json}\n', 'utf8');
      await assert.rejects(new EventStore(file).load(), /Corrupt JSONL/);

      const escaped = { ...first, email_file: '../secrets.eml' };
      await writeFile(file, `${JSON.stringify(escaped)}\n`, 'utf8');
      await assert.rejects(new EventStore(file).load(), /email_file path is not allowed/);
    } finally {
      await removeTemp(dir);
    }
  });

  it('strips a leading BOM and skips blank lines', async () => {
    const dir = await makeTempDir();
    try {
      const file = join(dir, 'events.jsonl');
      await writeFile(file, `\uFEFF${JSON.stringify(record())}\n\n`, 'utf8');
      const store = new EventStore(file);
      await store.load();
      assert.equal(store.size(), 1);
    } finally {
      await removeTemp(dir);
    }
  });
});
