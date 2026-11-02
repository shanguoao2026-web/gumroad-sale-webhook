import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EMAIL_FILE_RE } from './limits.js';
import { formatCents } from './money.js';
import { resolveInside } from './paths.js';
import type { ResourceName, StoredRecord } from './types.js';

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function sanitizeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER_RE, (match, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      return match;
    }
    return sanitizeHeaderValue(value);
  });
}

export function templateVars(record: StoredRecord, from: string): Record<string, string> {
  const received = new Date(record.received_at);
  const date = Number.isNaN(received.getTime()) ? record.received_at : received.toUTCString();
  return {
    from,
    email: record.email,
    full_name: record.full_name,
    greeting_name: record.full_name || 'there',
    product_name: record.product_name,
    sale_id: record.sale_id,
    order_number: record.order_number || 'n/a',
    price_display: formatCents(record.price_cents),
    currency: record.currency.toUpperCase(),
    quantity: String(record.quantity),
    test_prefix: record.test ? '[test] ' : '',
    date,
    resource_name: record.resource_name,
    seller_id: record.seller_id,
    product_id: record.product_id,
  };
}

export function emailRelativePath(resourceName: ResourceName, saleId: string): string {
  return `outbox/${resourceName}--${saleId}.eml`;
}

export class Outbox {
  private readonly templates = new Map<ResourceName, string>();

  constructor(
    private readonly dataDir: string,
    private readonly templatesDir: string,
    private readonly from: string,
  ) {}

  async load(): Promise<void> {
    for (const name of ['sale', 'refund'] as const) {
      const path = join(this.templatesDir, `${name}.txt`);
      try {
        this.templates.set(name, await readFile(path, 'utf8'));
      } catch {
        throw new Error(`Missing email template: ${path}`);
      }
    }
  }

  render(record: StoredRecord): string {
    const template = this.templates.get(record.resource_name);
    if (template === undefined) {
      throw new Error(`No template loaded for ${record.resource_name}`);
    }
    return renderTemplate(template, templateVars(record, this.from));
  }

  async writeIfMissing(record: StoredRecord): Promise<boolean> {
    if (!record.email_file) {
      return false;
    }
    if (!EMAIL_FILE_RE.test(record.email_file)) {
      throw new Error('email_file path is not allowed');
    }
    const target = resolveInside(this.dataDir, record.email_file);
    if (existsSync(target)) {
      return false;
    }
    const body = this.render(record);
    await mkdir(dirname(target), { recursive: true });
    const temporary = join(dirname(target), `.tmp-${randomBytes(8).toString('hex')}.eml`);
    await writeFile(temporary, body, 'utf8');
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      if (existsSync(target)) {
        return false;
      }
      throw error;
    }
    return true;
  }
}
