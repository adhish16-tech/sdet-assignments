import { SubscriptionStatus } from '../domain/SubscriptionStateMachine';

/** Persisted rows. Dates are ISO strings so stored data is plain and copyable. */

export interface Customer {
  id: string;
  email: string;
  paymentMethodIds: string[];
}

export interface SubscriptionRow {
  id: string;
  customerId: string;
  paymentMethodId: string;
  plan: string;
  priceCents: number;
  currency: string;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string; // next charge is due at this time
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * open          = awaiting payment (new, timed out, or failed with retries left)
 * paid          = money confirmed (by provider response or payment.succeeded webhook)
 * uncollectible = retries exhausted
 * void          = subscription canceled before it was paid
 * refunded      = was paid, then refunded
 */
export type InvoiceStatus = 'open' | 'paid' | 'uncollectible' | 'void' | 'refunded';

export interface InvoiceRow {
  id: string;
  subscriptionId: string;
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  attemptCount: number;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row per call we made to the payment provider. */
export interface PaymentAttemptRow {
  id: string;
  invoiceId: string;
  subscriptionId: string;
  attemptNumber: number;
  idempotencyKey: string;
  outcome: 'succeeded' | 'declined' | 'timeout';
  providerChargeId: string | null;
  declineCode: string | null;
  createdAt: string;
}

export type WebhookOutcome =
  | 'applied'
  | 'ignored_subscription_canceled'
  | 'ignored_invoice_not_open'
  | 'ignored_invalid_transition'
  | 'ignored_unknown_reference'
  | 'rejected_amount_mismatch';

/** One row per unique provider event_id. Redeliveries bump deliveryCount only. */
export interface WebhookEventRow {
  eventId: string;
  type: string;
  subscriptionId: string;
  invoiceId: string;
  outcome: WebhookOutcome;
  deliveryCount: number;
  firstReceivedAt: string;
  lastReceivedAt: string;
}

/** Append-only history of everything that happened to a subscription. */
export interface AuditLogRow {
  seq: number;
  subscriptionId: string;
  action: string; // e.g. 'created', 'transition', 'invoice.paid'
  fromStatus: SubscriptionStatus | null;
  toStatus: SubscriptionStatus | null;
  source: 'api' | 'billing_run' | 'webhook';
  reference: string | null; // invoice id / event id that caused it
  at: string;
}

/** Customer-facing side effect, modelled so we can prove it never fires twice. */
export interface NotificationRow {
  id: string;
  subscriptionId: string;
  kind: 'subscription_activated' | 'payment_failed' | 'subscription_canceled';
  at: string;
}
