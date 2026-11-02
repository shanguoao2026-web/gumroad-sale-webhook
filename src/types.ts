export type ResourceName = 'sale' | 'refund';

export type EmailSkipReason = 'refund_already_recorded' | 'sale_marked_refunded';

export interface PingEvent {
  sale_id: string;
  resource_name: ResourceName;
  email: string;
  full_name: string;
  seller_id: string;
  product_id: string;
  short_product_id: string;
  product_name: string;
  product_permalink: string;
  price_cents: number;
  gumroad_fee_cents: number | null;
  currency: string;
  quantity: number;
  order_number: string;
  sale_timestamp: string;
  refunded: boolean;
  test: boolean;
  ip_country: string;
  recurrence: string;
  can_contact: boolean | null;
  discover_fee_charged: boolean | null;
}

export interface StoredRecord extends PingEvent {
  dedupe_key: string;
  received_at: string;
  email_file: string | null;
  email_skipped_reason: EmailSkipReason | null;
}

export type IngestResult =
  | {
      status: 'accepted' | 'duplicate';
      record: StoredRecord;
      healed: boolean;
    }
  | {
      status: 'invalid';
      errors: string[];
    };

export function dedupeKey(resourceName: ResourceName, saleId: string): string {
  return `${resourceName}:${saleId}`;
}
