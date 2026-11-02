import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCents, signedCents } from '../src/money.js';
import { parsePingBody } from '../src/validate.js';
import { formBody, saleForm } from './helpers.js';

describe('parsePingBody', () => {
  it('accepts a complete fictional sale', () => {
    const parsed = parsePingBody(saleForm());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.event.sale_id, 'sale_fieldnotes_1001');
    assert.equal(parsed.event.resource_name, 'sale');
    assert.equal(parsed.event.email, 'ada.quill@example.com');
    assert.equal(parsed.event.price_cents, 1800);
    assert.equal(parsed.event.gumroad_fee_cents, 230);
    assert.equal(parsed.event.currency, 'usd');
    assert.equal(parsed.event.quantity, 1);
    assert.equal(parsed.event.refunded, false);
    assert.equal(parsed.event.ip_country, 'US');
    assert.equal(parsed.event.can_contact, null);
  });

  it('accepts a refund and treats a missing refunded flag as true', () => {
    const parsed = parsePingBody(saleForm({ resource_name: 'refund', refunded: '' }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.event.resource_name, 'refund');
    assert.equal(parsed.event.refunded, true);
  });

  it('infers a sale when resource_name is omitted', () => {
    const parsed = parsePingBody(
      formBody({
        seller_id: 'seller_nwp_01',
        product_name: 'Northwind Field Notes',
        email: 'ada.quill@example.com',
        price: '1800',
        sale_id: 'sale_fieldnotes_1001',
      }),
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.event.resource_name, 'sale');
    assert.equal(parsed.event.refunded, false);
    assert.equal(parsed.event.currency, 'usd');
    assert.equal(parsed.event.quantity, 1);
    assert.equal(parsed.event.gumroad_fee_cents, null);
  });

  it('infers a refund when resource_name is omitted and refunded is true', () => {
    const parsed = parsePingBody(
      formBody({
        seller_id: 'seller_nwp_01',
        product_name: 'Northwind Field Notes',
        email: 'ada.quill@example.com',
        price: '1800',
        sale_id: 'sale_fieldnotes_1001',
        refunded: 'true',
      }),
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.event.resource_name, 'refund');
    assert.equal(parsed.event.refunded, true);
  });

  it('collects missing required fields', () => {
    const parsed = parsePingBody('resource_name=sale');
    assert.equal(parsed.ok, false);
    if (parsed.ok) {
      return;
    }
    assert.ok(parsed.errors.includes('sale_id is required'));
    assert.ok(parsed.errors.includes('email is required'));
    assert.ok(parsed.errors.includes('product_name is required'));
    assert.ok(parsed.errors.includes('price is required'));
    assert.ok(parsed.errors.includes('seller_id is required'));
  });

  it('rejects a bad email, a fractional price, and an unknown resource', () => {
    const parsed = parsePingBody(
      saleForm({
        email: 'not-an-email',
        price: '18.00',
        resource_name: 'dispute',
      }),
    );
    assert.equal(parsed.ok, false);
    if (parsed.ok) {
      return;
    }
    assert.ok(parsed.errors.includes('email is not a valid address'));
    assert.ok(parsed.errors.includes('price must be a non-negative integer number of cents'));
    assert.ok(parsed.errors.includes('resource_name must be sale or refund'));
  });

  it('rejects a refund that says it was not refunded', () => {
    const parsed = parsePingBody(saleForm({ resource_name: 'refund', refunded: 'false' }));
    assert.equal(parsed.ok, false);
    if (parsed.ok) {
      return;
    }
    assert.ok(parsed.errors.includes('refunded must be true when resource_name is refund'));
  });

  it('accepts a zero price and a URL-safe sale id', () => {
    const parsed = parsePingBody(saleForm({ price: '0', sale_id: 'gyb1l', gumroad_fee: '0' }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.event.price_cents, 0);
    assert.equal(parsed.event.sale_id, 'gyb1l');
  });

  it('rejects control characters, path-like ids, and an oversized price', () => {
    const parsed = parsePingBody(
      saleForm({
        product_name: 'Notes\nBcc: steal@example.com',
        sale_id: '../etc/passwd',
        price: '1000000001',
      }),
    );
    assert.equal(parsed.ok, false);
    if (parsed.ok) {
      return;
    }
    assert.ok(parsed.errors.some((error) => error.startsWith('product_name')));
    assert.ok(parsed.errors.some((error) => error.startsWith('sale_id')));
    assert.ok(parsed.errors.includes('price exceeds the supported maximum'));
  });

  it('still validates a body that ends with a newline', () => {
    const parsed = parsePingBody(`${saleForm()}\n`);
    assert.equal(parsed.ok, true);
  });

  it('rejects a refunded flag that is not a boolean', () => {
    const parsed = parsePingBody(saleForm({ refunded: 'maybe' }));
    assert.equal(parsed.ok, false);
    if (parsed.ok) {
      return;
    }
    assert.ok(parsed.errors.includes('refunded must be true or false'));
  });
});

describe('money', () => {
  it('formats cents without binary floating point', () => {
    assert.equal(formatCents(0), '0.00');
    assert.equal(formatCents(5), '0.05');
    assert.equal(formatCents(1800), '18.00');
    assert.equal(formatCents(-2500), '-25.00');
  });

  it('signs refunds and leaves sales positive', () => {
    assert.equal(signedCents('sale', 1800), 1800);
    assert.equal(signedCents('refund', 1800), -1800);
    assert.equal(signedCents('refund', 0), 0);
  });
});
