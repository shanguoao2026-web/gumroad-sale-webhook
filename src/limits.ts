export const SERVICE_NAME = 'gumroad-sale-webhook';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_FROM = 'Northwind Press <ledger@example.com>';
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_PRICE_CENTS = 1_000_000_000;
export const MAX_QUANTITY = 10_000;
export const MAX_PRODUCT_NAME = 300;
export const MAX_FULL_NAME = 200;
export const MAX_PERMALINK = 500;

export const TOKEN_RE = /^[A-Za-z0-9._~\-]{16,256}$/;
export const HOST_RE = /^[A-Za-z0-9.:_-]{1,255}$/;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~+=-]{0,127}$/;
export const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/;
export const CONTROL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/;
export const EMAIL_FILE_RE = /^outbox\/(?:sale|refund)--[A-Za-z0-9][A-Za-z0-9._~+=-]{0,127}\.eml$/;

export const RECURRENCE_VALUES = new Set([
  'monthly',
  'quarterly',
  'biannually',
  'yearly',
  'every_two_years',
]);

export function tokenError(token: string): string | null {
  if (!TOKEN_RE.test(token)) {
    return 'token must be 16-256 characters and use only letters, digits, dot, underscore, tilde, and hyphen';
  }
  return null;
}

export function fromError(from: string): string | null {
  const trimmed = from.trim();
  if (trimmed.length < 3 || trimmed.length > 200 || !trimmed.includes('@') || /[\r\n\0]/.test(trimmed)) {
    return 'from address must be 3-200 characters, include @, and not contain newlines';
  }
  return null;
}

export function hostError(host: string): string | null {
  if (!HOST_RE.test(host)) {
    return 'host contains unsupported characters';
  }
  return null;
}

export function portError(value: string): string | null {
  if (!/^\d+$/.test(value)) {
    return 'port must be an integer from 0 to 65535';
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return 'port must be an integer from 0 to 65535';
  }
  return null;
}
