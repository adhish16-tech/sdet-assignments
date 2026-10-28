import { signPayload } from '../../../src/service/WebhookHandler';

export interface WebhookDelivery {
  rawBody: string;
  signature: string | undefined; // undefined = header not sent
}

type Signing = 'valid' | 'missing' | 'wrong_secret' | 'tampered_body';

let eventCounter = 0;

/**
 * PATTERN: Builder for signed provider webhooks.
 *
 * Covers the happy path AND the attacks in one fluent object:
 *   aWebhook(secret).paymentSucceeded().forInvoice(inv).build()
 *   aWebhook(secret).paymentSucceeded().forInvoice(inv).signedWithWrongSecret().build()
 * Each builder gets a fresh event_id unless one is fixed with withEventId().
 */
export class WebhookEventBuilder {
  private payload: Record<string, unknown> = {
    event_id: `evt_${String(++eventCounter).padStart(4, '0')}`,
    type: 'payment.succeeded',
    subscription_id: 'sub_001',
    invoice_id: 'inv_001',
    amount: 4900,
    currency: 'USD',
  };
  private signing: Signing = 'valid';
  private rawOverride: string | null = null;

  constructor(private readonly secret: string) {}

  static aWebhook(secret: string): WebhookEventBuilder {
    return new WebhookEventBuilder(secret);
  }

  paymentSucceeded(): this {
    this.payload.type = 'payment.succeeded';
    return this;
  }
  paymentFailed(): this {
    this.payload.type = 'payment.failed';
    return this;
  }
  paymentRefunded(): this {
    this.payload.type = 'payment.refunded';
    return this;
  }

  /** Points the event at a real invoice and copies its amount/currency. */
  forInvoice(invoice: { id: string; subscriptionId: string; amountCents: number; currency: string }): this {
    this.payload.invoice_id = invoice.id;
    this.payload.subscription_id = invoice.subscriptionId;
    this.payload.amount = invoice.amountCents;
    this.payload.currency = invoice.currency;
    return this;
  }

  withEventId(eventId: string): this {
    this.payload.event_id = eventId;
    return this;
  }
  withAmount(cents: number): this {
    this.payload.amount = cents;
    return this;
  }
  withField(name: string, value: unknown): this {
    this.payload[name] = value;
    return this;
  }
  withoutField(name: string): this {
    delete this.payload[name];
    return this;
  }

  unsigned(): this {
    this.signing = 'missing';
    return this;
  }
  signedWithWrongSecret(): this {
    this.signing = 'wrong_secret';
    return this;
  }
  /** Signs the original body, then changes the amount: simulates tampering in transit. */
  withTamperedBody(): this {
    this.signing = 'tampered_body';
    return this;
  }
  /** Sends a raw body that is not JSON (but is correctly signed). */
  withRawBody(raw: string): this {
    this.rawOverride = raw;
    return this;
  }

  get eventId(): string {
    return this.payload.event_id as string;
  }

  build(): WebhookDelivery {
    const rawBody = this.rawOverride ?? JSON.stringify(this.payload);
    switch (this.signing) {
      case 'missing':
        return { rawBody, signature: undefined };
      case 'wrong_secret':
        return { rawBody, signature: signPayload(rawBody, 'not-the-real-secret') };
      case 'tampered_body': {
        const signature = signPayload(rawBody, this.secret);
        const tampered = JSON.stringify({ ...this.payload, amount: 1 });
        return { rawBody: tampered, signature };
      }
      default:
        return { rawBody, signature: signPayload(rawBody, this.secret) };
    }
  }
}
