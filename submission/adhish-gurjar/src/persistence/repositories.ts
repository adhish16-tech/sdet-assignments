import { Database } from './Database';
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
 * PATTERN: Repository.
 *
 * Problem it solves: both the service AND the tests need to read persisted
 * data. Repositories give one named query per question ("invoices for this
 * subscription") instead of raw map lookups scattered through test files.
 *
 * Every read returns a deep COPY. If tests got live references, a test could
 * accidentally see (or cause) a mutation and pass for the wrong reason.
 */

const copy = <T>(value: T): T => structuredClone(value);

export class CustomerRepository {
  constructor(private readonly db: Database) {}
  save(c: Customer): void {
    this.db.customers.set(c.id, copy(c));
  }
  findById(id: string): Customer | undefined {
    const c = this.db.customers.get(id);
    return c && copy(c);
  }
}

export class SubscriptionRepository {
  constructor(private readonly db: Database) {}
  insert(row: SubscriptionRow): void {
    if (this.db.subscriptions.has(row.id)) throw new Error(`Duplicate subscription ${row.id}`);
    this.db.subscriptions.set(row.id, copy(row));
  }
  update(row: SubscriptionRow): void {
    if (!this.db.subscriptions.has(row.id)) throw new Error(`Unknown subscription ${row.id}`);
    this.db.subscriptions.set(row.id, copy(row));
  }
  findById(id: string): SubscriptionRow | undefined {
    const s = this.db.subscriptions.get(id);
    return s && copy(s);
  }
  findAll(): SubscriptionRow[] {
    return [...this.db.subscriptions.values()].map(copy);
  }
  count(): number {
    return this.db.subscriptions.size;
  }
}

export class InvoiceRepository {
  constructor(private readonly db: Database) {}
  insert(row: InvoiceRow): void {
    if (this.db.invoices.has(row.id)) throw new Error(`Duplicate invoice ${row.id}`);
    this.db.invoices.set(row.id, copy(row));
  }
  update(row: InvoiceRow): void {
    this.db.invoices.set(row.id, copy(row));
  }
  findById(id: string): InvoiceRow | undefined {
    const i = this.db.invoices.get(id);
    return i && copy(i);
  }
  findBySubscription(subscriptionId: string): InvoiceRow[] {
    return [...this.db.invoices.values()].filter((i) => i.subscriptionId === subscriptionId).map(copy);
  }
  findOpenForSubscription(subscriptionId: string): InvoiceRow | undefined {
    return this.findBySubscription(subscriptionId).find((i) => i.status === 'open');
  }
  count(): number {
    return this.db.invoices.size;
  }
}

export class PaymentAttemptRepository {
  constructor(private readonly db: Database) {}
  insert(row: PaymentAttemptRow): void {
    this.db.paymentAttempts.set(row.id, copy(row));
  }
  findByInvoice(invoiceId: string): PaymentAttemptRow[] {
    return [...this.db.paymentAttempts.values()].filter((a) => a.invoiceId === invoiceId).map(copy);
  }
  findBySubscription(subscriptionId: string): PaymentAttemptRow[] {
    return [...this.db.paymentAttempts.values()].filter((a) => a.subscriptionId === subscriptionId).map(copy);
  }
  count(): number {
    return this.db.paymentAttempts.size;
  }
}

export class WebhookEventRepository {
  constructor(private readonly db: Database) {}
  findByEventId(eventId: string): WebhookEventRow | undefined {
    const e = this.db.webhookEvents.get(eventId);
    return e && copy(e);
  }
  insert(row: WebhookEventRow): void {
    if (this.db.webhookEvents.has(row.eventId)) throw new Error(`Duplicate webhook event ${row.eventId}`);
    this.db.webhookEvents.set(row.eventId, copy(row));
  }
  recordRedelivery(eventId: string, at: string): void {
    const e = this.db.webhookEvents.get(eventId)!;
    this.db.webhookEvents.set(eventId, { ...e, deliveryCount: e.deliveryCount + 1, lastReceivedAt: at });
  }
  findBySubscription(subscriptionId: string): WebhookEventRow[] {
    return [...this.db.webhookEvents.values()].filter((e) => e.subscriptionId === subscriptionId).map(copy);
  }
  count(): number {
    return this.db.webhookEvents.size;
  }
}

export class AuditLogRepository {
  constructor(private readonly db: Database) {}
  append(row: Omit<AuditLogRow, 'seq'>): void {
    this.db.auditLog.push({ ...copy(row), seq: this.db.auditLog.length + 1 });
  }
  forSubscription(subscriptionId: string): AuditLogRow[] {
    return this.db.auditLog.filter((a) => a.subscriptionId === subscriptionId).map(copy);
  }
}

export class NotificationRepository {
  constructor(private readonly db: Database) {}
  record(row: Omit<NotificationRow, 'id'>): void {
    this.db.notifications.push({ ...copy(row), id: this.db.nextId('ntf') });
  }
  forSubscription(subscriptionId: string): NotificationRow[] {
    return this.db.notifications.filter((n) => n.subscriptionId === subscriptionId).map(copy);
  }
}

/** One object that hands out every repository for a given database. */
export class Repositories {
  readonly customers: CustomerRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly invoices: InvoiceRepository;
  readonly paymentAttempts: PaymentAttemptRepository;
  readonly webhookEvents: WebhookEventRepository;
  readonly auditLog: AuditLogRepository;
  readonly notifications: NotificationRepository;

  constructor(readonly db: Database) {
    this.customers = new CustomerRepository(db);
    this.subscriptions = new SubscriptionRepository(db);
    this.invoices = new InvoiceRepository(db);
    this.paymentAttempts = new PaymentAttemptRepository(db);
    this.webhookEvents = new WebhookEventRepository(db);
    this.auditLog = new AuditLogRepository(db);
    this.notifications = new NotificationRepository(db);
  }
}
