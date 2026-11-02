import { readFile } from 'node:fs/promises';
import { csvLine, parseCsv } from './csv.js';
import { appendText } from './fsutil.js';
import { signedCents } from './money.js';
import type { StoredRecord } from './types.js';

export const LEDGER_COLUMNS = [
  'dedupe_key',
  'received_at',
  'sale_id',
  'resource_name',
  'email',
  'full_name',
  'seller_id',
  'product_id',
  'product_name',
  'price_cents',
  'signed_cents',
  'gumroad_fee_cents',
  'currency',
  'quantity',
  'order_number',
  'sale_timestamp',
  'refunded',
  'test',
  'ip_country',
  'recurrence',
  'can_contact',
  'discover_fee_charged',
  'email_file',
  'email_skipped_reason',
] as const;

export type LedgerColumn = (typeof LEDGER_COLUMNS)[number];

const HEADER = LEDGER_COLUMNS.join(',');

export function ledgerColumn(name: LedgerColumn): number {
  return LEDGER_COLUMNS.indexOf(name);
}

export function recordToLedgerCells(record: StoredRecord): Array<string | number | boolean | null> {
  return [
    record.dedupe_key,
    record.received_at,
    record.sale_id,
    record.resource_name,
    record.email,
    record.full_name,
    record.seller_id,
    record.product_id,
    record.product_name,
    record.price_cents,
    signedCents(record.resource_name, record.price_cents),
    record.gumroad_fee_cents,
    record.currency,
    record.quantity,
    record.order_number,
    record.sale_timestamp,
    record.refunded,
    record.test,
    record.ip_country,
    record.recurrence,
    record.can_contact,
    record.discover_fee_charged,
    record.email_file,
    record.email_skipped_reason,
  ];
}

export class Ledger {
  private readonly keys = new Set<string>();
  private headerWritten = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    this.keys.clear();
    this.headerWritten = false;
    let text = '';
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (text.trim() === '') {
      return;
    }
    let rows: string[][];
    try {
      rows = parseCsv(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unreadable';
      throw new Error(`ledger.csv is corrupt: ${message}`);
    }
    const header = rows[0];
    if (!header || header.join(',') !== HEADER) {
      throw new Error('ledger.csv is corrupt: header does not match this version');
    }
    this.headerWritten = true;
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row || row.length !== LEDGER_COLUMNS.length) {
        throw new Error(`ledger.csv is corrupt: row ${index + 1} has the wrong number of columns`);
      }
      const key = row[0] ?? '';
      if (!key) {
        throw new Error(`ledger.csv is corrupt: row ${index + 1} is missing dedupe_key`);
      }
      if (this.keys.has(key)) {
        throw new Error(`ledger.csv is corrupt: duplicate dedupe_key ${key}`);
      }
      this.keys.add(key);
    }
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  size(): number {
    return this.keys.size;
  }

  async append(record: StoredRecord): Promise<boolean> {
    if (this.keys.has(record.dedupe_key)) {
      return false;
    }
    const line = csvLine(recordToLedgerCells(record));
    if (!this.headerWritten) {
      await appendText(this.file, `${HEADER}\n${line}\n`);
      this.headerWritten = true;
    } else {
      await appendText(this.file, `${line}\n`);
    }
    this.keys.add(record.dedupe_key);
    return true;
  }
}
