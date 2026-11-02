import {
  CONTROL_RE,
  EMAIL_RE,
  ID_RE,
  MAX_FULL_NAME,
  MAX_PERMALINK,
  MAX_PRICE_CENTS,
  MAX_PRODUCT_NAME,
  MAX_QUANTITY,
  RECURRENCE_VALUES,
  TIMESTAMP_RE,
} from './limits.js';
import type { PingEvent, ResourceName } from './types.js';

export interface ValidPing {
  ok: true;
  event: PingEvent;
}

export interface InvalidPing {
  ok: false;
  errors: string[];
}

export type ParsePingResult = ValidPing | InvalidPing;

export function normalizeFormBody(body: string): string {
  return body.replace(/^\uFEFF/, '').replace(/[\r\n]+$/g, '');
}

export function parsePingBody(body: string): ParsePingResult {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(normalizeFormBody(body));
  } catch {
    return { ok: false, errors: ['body is not valid form data'] };
  }
  return validateParams(params);
}

function field(params: URLSearchParams, name: string): string {
  return (params.get(name) ?? '').trim();
}

function checkId(value: string, name: string, required: boolean, errors: string[]): string {
  if (!value) {
    if (required) {
      errors.push(`${name} is required`);
    }
    return '';
  }
  if (value.length > 128) {
    errors.push(`${name} is too long`);
    return '';
  }
  if (!ID_RE.test(value)) {
    errors.push(`${name} has unsupported characters`);
    return '';
  }
  return value;
}

function checkText(
  value: string,
  name: string,
  required: boolean,
  max: number,
  errors: string[],
): string {
  if (!value) {
    if (required) {
      errors.push(`${name} is required`);
    }
    return '';
  }
  if (value.length > max || CONTROL_RE.test(value)) {
    errors.push(`${name} has unsupported characters or is too long`);
    return '';
  }
  return value;
}

function parseRequiredBool(raw: string, name: string, fallback: boolean, errors: string[]): boolean {
  if (!raw) {
    return fallback;
  }
  const lower = raw.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }
  errors.push(`${name} must be true or false`);
  return fallback;
}

function parseOptionalBool(raw: string, name: string, errors: string[]): boolean | null {
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }
  errors.push(`${name} must be true or false`);
  return null;
}

function parseCents(raw: string, name: string, required: boolean, errors: string[]): number | null {
  if (!raw) {
    if (required) {
      errors.push(`${name} is required`);
    }
    return null;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    errors.push(`${name} must be a non-negative integer number of cents`);
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_PRICE_CENTS) {
    errors.push(`${name} exceeds the supported maximum`);
    return null;
  }
  return value;
}

function validateParams(params: URLSearchParams): ParsePingResult {
  const errors: string[] = [];
  const refundedRaw = field(params, 'refunded');
  let resourceRaw = field(params, 'resource_name').toLowerCase();

  if (!resourceRaw) {
    if (!refundedRaw || refundedRaw.toLowerCase() === 'false') {
      resourceRaw = 'sale';
    } else if (refundedRaw.toLowerCase() === 'true') {
      resourceRaw = 'refund';
    } else {
      errors.push('refunded must be true or false');
      resourceRaw = 'sale';
    }
  } else if (resourceRaw !== 'sale' && resourceRaw !== 'refund') {
    errors.push('resource_name must be sale or refund');
  }

  const resourceName: ResourceName = resourceRaw === 'refund' ? 'refund' : 'sale';
  let refunded = false;
  if (!refundedRaw) {
    refunded = resourceName === 'refund';
  } else if (refundedRaw.toLowerCase() === 'true') {
    refunded = true;
  } else if (refundedRaw.toLowerCase() === 'false') {
    refunded = false;
    if (resourceName === 'refund') {
      errors.push('refunded must be true when resource_name is refund');
    }
  } else if (!errors.includes('refunded must be true or false')) {
    errors.push('refunded must be true or false');
  }

  const saleId = checkId(field(params, 'sale_id'), 'sale_id', true, errors);
  const sellerId = checkId(field(params, 'seller_id'), 'seller_id', true, errors);
  const productId = checkId(field(params, 'product_id'), 'product_id', false, errors);
  const shortProductId = checkId(field(params, 'short_product_id'), 'short_product_id', false, errors);
  const emailRaw = field(params, 'email');
  let email = '';
  if (!emailRaw) {
    errors.push('email is required');
  } else if (emailRaw.length > 254 || emailRaw.includes('..') || !EMAIL_RE.test(emailRaw)) {
    errors.push('email is not a valid address');
  } else {
    email = emailRaw;
  }

  const productName = checkText(field(params, 'product_name'), 'product_name', true, MAX_PRODUCT_NAME, errors);
  const fullName = checkText(field(params, 'full_name'), 'full_name', false, MAX_FULL_NAME, errors);
  const permalinkRaw = field(params, 'product_permalink') || field(params, 'permalink');
  const productPermalink = checkText(permalinkRaw, 'product_permalink', false, MAX_PERMALINK, errors);

  const price = parseCents(field(params, 'price'), 'price', true, errors);
  const fee = parseCents(field(params, 'gumroad_fee'), 'gumroad_fee', false, errors);

  const currencyRaw = field(params, 'currency');
  let currency = 'usd';
  if (currencyRaw) {
    if (!/^[A-Za-z]{3}$/.test(currencyRaw)) {
      errors.push('currency must be a 3-letter code');
    } else {
      currency = currencyRaw.toLowerCase();
    }
  }

  const quantityRaw = field(params, 'quantity');
  let quantity = 1;
  if (quantityRaw) {
    if (!/^[1-9][0-9]*$/.test(quantityRaw)) {
      errors.push('quantity must be a positive integer');
    } else {
      quantity = Number(quantityRaw);
      if (!Number.isSafeInteger(quantity) || quantity > MAX_QUANTITY) {
        errors.push('quantity exceeds the supported maximum');
        quantity = 1;
      }
    }
  }

  const orderRaw = field(params, 'order_number');
  let orderNumber = '';
  if (orderRaw) {
    if (!/^[0-9]{1,20}$/.test(orderRaw)) {
      errors.push('order_number must be 1-20 digits');
    } else {
      orderNumber = orderRaw;
    }
  }

  const timestampRaw = field(params, 'sale_timestamp');
  let saleTimestamp = '';
  if (timestampRaw) {
    if (!TIMESTAMP_RE.test(timestampRaw)) {
      errors.push('sale_timestamp must be a UTC timestamp such as 2026-04-12T15:04:05Z');
    } else {
      saleTimestamp = timestampRaw;
    }
  }

  const countryRaw = field(params, 'ip_country');
  let ipCountry = '';
  if (countryRaw) {
    if (!/^[A-Za-z]{2}$/.test(countryRaw)) {
      errors.push('ip_country must be a 2-letter code');
    } else {
      ipCountry = countryRaw.toUpperCase();
    }
  }

  const recurrenceRaw = field(params, 'recurrence').toLowerCase();
  let recurrence = '';
  if (recurrenceRaw) {
    if (!RECURRENCE_VALUES.has(recurrenceRaw)) {
      errors.push('recurrence must be monthly, quarterly, biannually, yearly, or every_two_years');
    } else {
      recurrence = recurrenceRaw;
    }
  }

  const test = parseRequiredBool(field(params, 'test'), 'test', false, errors);
  const canContact = parseOptionalBool(field(params, 'can_contact'), 'can_contact', errors);
  const discoverFee = parseOptionalBool(
    field(params, 'discover_fee_charged'),
    'discover_fee_charged',
    errors,
  );

  if (errors.length > 0 || price === null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    event: {
      sale_id: saleId,
      resource_name: resourceName,
      email,
      full_name: fullName,
      seller_id: sellerId,
      product_id: productId,
      short_product_id: shortProductId,
      product_name: productName,
      product_permalink: productPermalink,
      price_cents: price,
      gumroad_fee_cents: fee,
      currency,
      quantity,
      order_number: orderNumber,
      sale_timestamp: saleTimestamp,
      refunded,
      test,
      ip_country: ipCountry,
      recurrence,
      can_contact: canContact,
      discover_fee_charged: discoverFee,
    },
  };
}
