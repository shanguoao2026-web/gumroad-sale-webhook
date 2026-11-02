import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { EMAIL_FILE_RE } from './limits.js';
import { appendText } from './fsutil.js';
import { dedupeKey, type EmailSkipReason, type StoredRecord } from './types.js';

const SKIP_REASONS = new Set<EmailSkipReason>(['refund_already_recorded', 'sale_marked_refunded']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(record: Record<string, unknown>, key: string, line: number): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`events.jsonl:${line} field ${key} must be a string`);
  }
  return value;
}

function expectNullableString(record: Record<string, unknown>, key: string, line: number): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`events.jsonl:${line} field ${key} must be a string or null`);
  }
  return value;
}

function expectBoolean(record: Record<string, unknown>, key: string, line: number): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`events.jsonl:${line} field ${key} must be a boolean`);
  }
  return value;
}

function expectNullableBoolean(record: Record<string, unknown>, key: string, line: number): boolean | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`events.jsonl:${line} field ${key} must be a boolean or null`);
  }
  return value;
}

function expectInt(record: Record<string, unknown>, key: string, line: number, min: number): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`events.jsonl:${line} field ${key} must be an integer`);
  }
  return value;
}

function expectNullableInt(record: Record<string, unknown>, key: string, line: number): number | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`events.jsonl:${line} field ${key} must be an integer or null`);
  }
  return value;
}

export function parseStoredRecord(value: unknown, line: number): StoredRecord {
  if (!isObject(value)) {
    throw new Error(`events.jsonl:${line} must be a JSON object`);
  }
  const resourceName = expectString(value, 'resource_name', line);
  if (resourceName !== 'sale' && resourceName !== 'refund') {
    throw new Error(`events.jsonl:${line} field resource_name is invalid`);
  }
  const saleId = expectString(value, 'sale_id', line);
  const expectedKey = dedupeKey(resourceName, saleId);
  const key = expectString(value, 'dedupe_key', line);
  if (key !== expectedKey) {
    throw new Error(`events.jsonl:${line} dedupe_key does not match resource_name and sale_id`);
  }
  const emailFile = expectNullableString(value, 'email_file', line);
  if (emailFile !== null && !EMAIL_FILE_RE.test(emailFile)) {
    throw new Error(`events.jsonl:${line} email_file path is not allowed`);
  }
  const reasonRaw = expectNullableString(value, 'email_skipped_reason', line);
  let emailSkipped: EmailSkipReason | null = null;
  if (reasonRaw !== null) {
    if (!SKIP_REASONS.has(reasonRaw as EmailSkipReason)) {
      throw new Error(`events.jsonl:${line} email_skipped_reason is invalid`);
    }
    emailSkipped = reasonRaw as EmailSkipReason;
  }
  const record: StoredRecord = {
    dedupe_key: key,
    received_at: expectString(value, 'received_at', line),
    sale_id: saleId,
    resource_name: resourceName,
    email: expectString(value, 'email', line),
    full_name: expectString(value, 'full_name', line),
    seller_id: expectString(value, 'seller_id', line),
    product_id: expectString(value, 'product_id', line),
    short_product_id: expectString(value, 'short_product_id', line),
    product_name: expectString(value, 'product_name', line),
    product_permalink: expectString(value, 'product_permalink', line),
    price_cents: expectInt(value, 'price_cents', line, 0),
    gumroad_fee_cents: expectNullableInt(value, 'gumroad_fee_cents', line),
    currency: expectString(value, 'currency', line),
    quantity: expectInt(value, 'quantity', line, 1),
    order_number: expectString(value, 'order_number', line),
    sale_timestamp: expectString(value, 'sale_timestamp', line),
    refunded: expectBoolean(value, 'refunded', line),
    test: expectBoolean(value, 'test', line),
    ip_country: expectString(value, 'ip_country', line),
    recurrence: expectString(value, 'recurrence', line),
    can_contact: expectNullableBoolean(value, 'can_contact', line),
    discover_fee_charged: expectNullableBoolean(value, 'discover_fee_charged', line),
    email_file: emailFile,
    email_skipped_reason: emailSkipped,
  };
  return record;
}

export class EventStore {
  private readonly byKey = new Map<string, StoredRecord>();
  private readonly records: StoredRecord[] = [];

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    this.byKey.clear();
    this.records.length = 0;
    try {
      await access(this.file);
    } catch {
      return;
    }
    const lines = createInterface({
      input: createReadStream(this.file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let lineNumber = 0;
    for await (const rawLine of lines) {
      lineNumber += 1;
      let line = rawLine;
      if (lineNumber === 1 && line.charCodeAt(0) === 0xfeff) {
        line = line.slice(1);
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        throw new Error(`Corrupt JSONL at events.jsonl:${lineNumber}`);
      }
      const record = parseStoredRecord(parsed, lineNumber);
      if (this.byKey.has(record.dedupe_key)) {
        throw new Error(`events.jsonl:${lineNumber} duplicates dedupe_key ${record.dedupe_key}`);
      }
      this.byKey.set(record.dedupe_key, record);
      this.records.push(record);
    }
  }

  get(key: string): StoredRecord | undefined {
    return this.byKey.get(key);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  list(): readonly StoredRecord[] {
    return this.records;
  }

  size(): number {
    return this.records.length;
  }

  async append(record: StoredRecord): Promise<void> {
    if (this.byKey.has(record.dedupe_key)) {
      throw new Error(`duplicate dedupe_key ${record.dedupe_key}`);
    }
    await appendText(this.file, `${JSON.stringify(record)}\n`);
    this.byKey.set(record.dedupe_key, record);
    this.records.push(record);
  }
}
