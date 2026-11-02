import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderTemplate, templateVars, Outbox } from '../src/email.js';
import { DEFAULT_FROM } from '../src/limits.js';
import { dedupeKey, type StoredRecord } from '../src/types.js';
import { makeTempDir, removeTemp, templatesDir } from './helpers.js';

function stored(): StoredRecord {
  return {
    dedupe_key: dedupeKey('sale', 'sale_fieldnotes_1001'),
    received_at: '2026-04-12T15:04:05.000Z',
    sale_id: 'sale_fieldnotes_1001',
    resource_name: 'sale',
    email: 'ada.quill@example.com',
    full_name: 'Ada Quill',
    seller_id: 'seller_nwp_01',
    product_id: 'prod_fieldnotes',
    short_product_id: '',
    product_name: 'Northwind Field Notes',
    product_permalink: '',
    price_cents: 1800,
    gumroad_fee_cents: 230,
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
    email_file: 'outbox/sale--sale_fieldnotes_1001.eml',
    email_skipped_reason: null,
  };
}

describe('email rendering', () => {
  it('fills placeholders and leaves unknown ones in place', () => {
    const rendered = renderTemplate('Hello {{greeting_name}} {{not_a_field}}', {
      greeting_name: 'Ada',
    });
    assert.equal(rendered, 'Hello Ada {{not_a_field}}');
  });

  it('strips newlines from substituted values', () => {
    const rendered = renderTemplate('Subject: {{full_name}}\n\nBody\n', {
      full_name: 'Ada\r\nBcc: steal@example.com',
    });
    assert.equal(rendered.includes('\nBcc:'), false);
    assert.match(rendered, /^Subject: Ada Bcc: steal@example.com\n/);
  });

  it('writes a sale message once and includes the unsent sentence', async () => {
    const dir = await makeTempDir();
    try {
      const outbox = new Outbox(dir, templatesDir(), DEFAULT_FROM);
      await outbox.load();
      const record = stored();
      assert.equal(await outbox.writeIfMissing(record), true);
      assert.equal(await outbox.writeIfMissing(record), false);
      const text = await readFile(join(dir, record.email_file ?? ''), 'utf8');
      assert.match(text, /This message was not sent\./);
      assert.match(text, /Subject: Your Northwind Field Notes is ready/);
      assert.match(text, /To: ada\.quill@example\.com/);
      assert.equal(templateVars(record, DEFAULT_FROM).price_display, '18.00');
    } finally {
      await removeTemp(dir);
    }
  });

  it('does not import a mailer', async () => {
    const source = await readFile(join(templatesDir(), '..', 'src', 'email.ts'), 'utf8');
    assert.doesNotMatch(source, /nodemailer|smtp:\/\//i);
  });
});
