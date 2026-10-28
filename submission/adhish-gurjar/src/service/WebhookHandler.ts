import { createHmac, timingSafeEqual } from 'crypto';
import { WebhookOutcome } from '../persistence/entities';
import { Repositories } from '../persistence/repositories';
import { Clock } from './Clock';
import { ServiceError } from './errors';
import { ProviderPaymentEvent, SubscriptionService } from './SubscriptionService';

const EVENT_TYPES = ['payment.succeeded', 'payment.failed', 'payment.refunded'] as const;

export function signPayload(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export interface WebhookResult {
  outcome: WebhookOutcome;
  duplicate: boolean;
}

/**
 * Inbound provider webhooks, in three gates:
 *   1. authenticity  — HMAC-SHA256 over the RAW body, else 401
 *   2. shape         — valid JSON with the required fields, else 400
 *   3. idempotency   — an event_id seen before is acknowledged but never re-applied
 * Authenticated, well-formed events always get 200 (so the provider stops
 * retrying); the body says what actually happened.
 */
export class WebhookHandler {
  constructor(
    private readonly secret: string,
    private readonly repos: Repositories,
    private readonly service: SubscriptionService,
    private readonly clock: Clock,
  ) {}

  handle(rawBody: string, signature: string | undefined): WebhookResult {
    this.verifySignature(rawBody, signature);
    const evt = this.parse(rawBody);
    const now = this.clock.now().toISOString();

    const seen = this.repos.webhookEvents.findByEventId(evt.event_id);
    if (seen) {
      this.repos.webhookEvents.recordRedelivery(evt.event_id, now);
      return { outcome: seen.outcome, duplicate: true };
    }

    const outcome = this.service.applyProviderEvent(evt);
    this.repos.webhookEvents.insert({
      eventId: evt.event_id,
      type: evt.type,
      subscriptionId: evt.subscription_id,
      invoiceId: evt.invoice_id,
      outcome,
      deliveryCount: 1,
      firstReceivedAt: now,
      lastReceivedAt: now,
    });
    return { outcome, duplicate: false };
  }

  private verifySignature(rawBody: string, signature: string | undefined): void {
    if (!signature) throw new ServiceError(401, 'missing_signature', 'X-Provider-Signature header is required');
    const expected = Buffer.from(signPayload(rawBody, this.secret), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new ServiceError(401, 'invalid_signature', 'Webhook signature does not match');
    }
  }

  private parse(rawBody: string): ProviderPaymentEvent {
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new ServiceError(400, 'malformed_payload', 'Body is not valid JSON');
    }
    const details: string[] = [];
    for (const f of ['event_id', 'subscription_id', 'invoice_id', 'currency']) {
      if (typeof body?.[f] !== 'string' || !body[f]) details.push(`${f} is required`);
    }
    if (!EVENT_TYPES.includes(body?.type)) details.push(`type must be one of ${EVENT_TYPES.join(', ')}`);
    if (!Number.isInteger(body?.amount) || body.amount <= 0) details.push('amount must be a positive integer (cents)');
    if (details.length) throw new ServiceError(400, 'malformed_payload', 'Invalid webhook payload', details);
    return body as ProviderPaymentEvent;
  }
}
