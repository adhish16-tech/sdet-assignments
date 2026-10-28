import {
  AuditLogRow,
  Customer,
  InvoiceRow,
  NotificationRow,
  PaymentAttemptRow,
  SubscriptionRow,
  WebhookEventRow,
} from './entities';

/**
 * Embedded in-memory database: one Map per table.
 *
 * Why in-memory: zero setup, and a fresh instance per test gives perfect
 * isolation (no stale rows from a previous test can cause a false pass).
 * Only repositories touch these maps — tests never read them directly.
 */
export class Database {
  readonly customers = new Map<string, Customer>();
  readonly subscriptions = new Map<string, SubscriptionRow>();
  readonly invoices = new Map<string, InvoiceRow>();
  readonly paymentAttempts = new Map<string, PaymentAttemptRow>();
  readonly webhookEvents = new Map<string, WebhookEventRow>();
  readonly auditLog: AuditLogRow[] = [];
  readonly notifications: NotificationRow[] = [];

  private counters = new Map<string, number>();

  /** Deterministic ids (sub_001, inv_001...) make failures easy to read. */
  nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(3, '0')}`;
  }
}
