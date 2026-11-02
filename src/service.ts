import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { emailRelativePath, Outbox } from './email.js';
import { Ledger } from './ledger.js';
import { EventStore } from './store.js';
import { dedupeKey, type EmailSkipReason, type IngestResult, type PingEvent, type StoredRecord } from './types.js';
import { parsePingBody } from './validate.js';

export interface PingServiceOptions {
  dataDir: string;
  templatesDir: string;
  from: string;
}

interface EmailDecision {
  email_file: string | null;
  email_skipped_reason: EmailSkipReason | null;
}

function toStored(event: PingEvent, decision: EmailDecision, now: Date): StoredRecord {
  return {
    dedupe_key: dedupeKey(event.resource_name, event.sale_id),
    received_at: now.toISOString(),
    sale_id: event.sale_id,
    resource_name: event.resource_name,
    email: event.email,
    full_name: event.full_name,
    seller_id: event.seller_id,
    product_id: event.product_id,
    short_product_id: event.short_product_id,
    product_name: event.product_name,
    product_permalink: event.product_permalink,
    price_cents: event.price_cents,
    gumroad_fee_cents: event.gumroad_fee_cents,
    currency: event.currency,
    quantity: event.quantity,
    order_number: event.order_number,
    sale_timestamp: event.sale_timestamp,
    refunded: event.refunded,
    test: event.test,
    ip_country: event.ip_country,
    recurrence: event.recurrence,
    can_contact: event.can_contact,
    discover_fee_charged: event.discover_fee_charged,
    email_file: decision.email_file,
    email_skipped_reason: decision.email_skipped_reason,
  };
}

export class PingService {
  private readonly store: EventStore;
  private readonly ledger: Ledger;
  private readonly outbox: Outbox;
  private ready = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: PingServiceOptions) {
    this.store = new EventStore(join(options.dataDir, 'events.jsonl'));
    this.ledger = new Ledger(join(options.dataDir, 'ledger.csv'));
    this.outbox = new Outbox(options.dataDir, options.templatesDir, options.from);
  }

  async init(): Promise<void> {
    if (this.ready) {
      throw new Error('PingService is already initialized');
    }
    await mkdir(join(this.options.dataDir, 'outbox'), { recursive: true });
    await this.outbox.load();
    await this.store.load();
    await this.ledger.load();
    for (const record of this.store.list()) {
      await this.project(record);
    }
    this.ready = true;
  }

  count(): number {
    return this.store.size();
  }

  list(): readonly StoredRecord[] {
    return this.store.list();
  }

  async ingest(body: string, now: Date = new Date()): Promise<IngestResult> {
    if (!this.ready) {
      throw new Error('PingService is not initialized');
    }
    const parsed = parsePingBody(body);
    if (!parsed.ok) {
      return { status: 'invalid', errors: parsed.errors };
    }
    return this.lock(async () => {
      // Refunds reuse sale_id, so the id alone cannot collapse a sale and its refund.
      const key = dedupeKey(parsed.event.resource_name, parsed.event.sale_id);
      const existing = this.store.get(key);
      if (existing) {
        const healed = await this.project(existing);
        return { status: 'duplicate', record: existing, healed };
      }
      const record = toStored(parsed.event, this.decideEmail(parsed.event), now);
      await this.store.append(record);
      await this.project(record);
      return { status: 'accepted', record, healed: false };
    });
  }

  private decideEmail(event: PingEvent): EmailDecision {
    if (event.resource_name === 'refund') {
      return {
        email_file: emailRelativePath('refund', event.sale_id),
        email_skipped_reason: null,
      };
    }
    if (this.store.has(dedupeKey('refund', event.sale_id))) {
      return { email_file: null, email_skipped_reason: 'refund_already_recorded' };
    }
    if (event.refunded) {
      return { email_file: null, email_skipped_reason: 'sale_marked_refunded' };
    }
    return {
      email_file: emailRelativePath('sale', event.sale_id),
      email_skipped_reason: null,
    };
  }

  private async project(record: StoredRecord): Promise<boolean> {
    const wroteLedger = await this.ledger.append(record);
    const wroteEmail = await this.outbox.writeIfMissing(record);
    return wroteLedger || wroteEmail;
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
