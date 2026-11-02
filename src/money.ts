import type { ResourceName } from './types.js';

export function signedCents(resourceName: ResourceName, priceCents: number): number {
  if (resourceName !== 'refund' || priceCents === 0) {
    return priceCents;
  }
  return -priceCents;
}

export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new Error('cents must be a safe integer');
  }
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.trunc(absolute / 100);
  const fraction = absolute % 100;
  return `${negative ? '-' : ''}${String(whole)}.${String(fraction).padStart(2, '0')}`;
}
