import { PlanCatalog } from '../../src/domain/plans';
import { SubscriptionStatus } from '../../src/domain/SubscriptionStateMachine';
import { InvoiceRow, SubscriptionRow } from '../../src/persistence/entities';
import { Repositories } from '../../src/persistence/repositories';
import { SubscriptionApiClient } from './SubscriptionApiClient';

/**
 * Assertion / verification layer.
 *
 * Reads persisted state ONLY through repositories, and states business rules
 * by name. Specs call `verify.expectState(id, 'active')` instead of repeating
 * six expect() lines, and `expectAllInvariantsHold()` runs after every test.
 */
export class SubscriptionVerifier {
  constructor(
    private readonly repos: Repositories,
    private readonly api: SubscriptionApiClient,
    private readonly plans: PlanCatalog,
  ) {}

  // ------------------------------------------------------------ readers

  subscription(id: string): SubscriptionRow {
    const row = this.repos.subscriptions.findById(id);
    if (!row) throw new Error(`Expected subscription ${id} to be persisted, found nothing`);
    return row;
  }
  invoices(subscriptionId: string): InvoiceRow[] {
    return this.repos.invoices.findBySubscription(subscriptionId);
  }
  openInvoice(subscriptionId: string): InvoiceRow {
    const inv = this.repos.invoices.findOpenForSubscription(subscriptionId);
    if (!inv) throw new Error(`Expected an open invoice for ${subscriptionId}`);
    return inv;
  }
  latestInvoice(subscriptionId: string): InvoiceRow {
    const all = this.invoices(subscriptionId);
    if (!all.length) throw new Error(`Expected at least one invoice for ${subscriptionId}`);
    return all[all.length - 1];
  }
  attempts(subscriptionId: string) {
    return this.repos.paymentAttempts.findBySubscription(subscriptionId);
  }
  webhookEvent(eventId: string) {
    return this.repos.webhookEvents.findByEventId(eventId);
  }
  audit(subscriptionId: string) {
    return this.repos.auditLog.forSubscription(subscriptionId);
  }
  /** Just the status path, e.g. ['trialing', 'active', 'canceled']. */
  statusHistory(subscriptionId: string): SubscriptionStatus[] {
    const rows = this.audit(subscriptionId).filter((a) => a.toStatus !== null);
    const path: SubscriptionStatus[] = [];
    for (const r of rows) if (path[path.length - 1] !== r.toStatus) path.push(r.toStatus!);
    return path;
  }
  notifications(subscriptionId: string) {
    return this.repos.notifications.forSubscription(subscriptionId);
  }

  // ------------------------------------------------------------ assertions

  /** The status is X in BOTH the API response and the database. */
  async expectState(id: string, status: SubscriptionStatus): Promise<void> {
    const res = await this.api.get(id);
    expect(res.status).toBe(200);
    expect({ api: res.body.status, db: this.subscription(id).status }).toEqual({ api: status, db: status });
  }

  /** Every field the API exposes equals what is stored. */
  async expectApiMatchesDatabase(id: string): Promise<void> {
    const { body } = await this.api.get(id);
    const row = this.subscription(id);
    expect(body).toEqual({
      id: row.id,
      customer_id: row.customerId,
      plan: row.plan,
      status: row.status,
      price_cents: row.priceCents,
      currency: row.currency,
      trial_ends_at: row.trialEndsAt,
      current_period_end: row.currentPeriodEnd,
      canceled_at: row.canceledAt,
      created_at: row.createdAt,
    });
  }

  /** Nothing was written for a rejected request. */
  expectNothingPersisted(): void {
    expect({
      subscriptions: this.repos.subscriptions.count(),
      invoices: this.repos.invoices.count(),
      paymentAttempts: this.repos.paymentAttempts.count(),
    }).toEqual({ subscriptions: 0, invoices: 0, paymentAttempts: 0 });
  }

  // ------------------------------------------------------------ invariants

  /**
   * Business rules that must hold for EVERY subscription at ANY moment.
   * Returns readable violations instead of throwing on the first one,
   * so a failure report lists everything that is wrong at once.
   */
  invariantViolations(): string[] {
    const v: string[] = [];

    for (const sub of this.repos.subscriptions.findAll()) {
      const tag = `[${sub.id} ${sub.status}]`;
      const invoices = this.invoices(sub.id);
      const attempts = this.attempts(sub.id);
      const plan = this.plans.get(sub.plan);

      // 1. active only with money on record
      if (sub.status === 'active' && !invoices.some((i) => i.status === 'paid' || i.status === 'refunded')) {
        v.push(`${tag} is active but has no paid invoice`);
      }
      // 2. canceled is final and stops billing
      if (sub.status === 'canceled') {
        if (!sub.canceledAt) v.push(`${tag} has no canceledAt`);
        if (invoices.some((i) => i.status === 'open')) v.push(`${tag} still has an open invoice`);
      } else if (sub.canceledAt) {
        v.push(`${tag} has canceledAt but is not canceled`);
      }
      // 3. plan rules applied consistently from creation to billing
      if (sub.priceCents !== plan.priceCents) v.push(`${tag} price ${sub.priceCents} != plan ${plan.priceCents}`);
      for (const inv of invoices) {
        if (inv.amountCents !== plan.priceCents) v.push(`${tag} ${inv.id} amount ${inv.amountCents} != plan price`);
        if ((inv.status === 'paid' || inv.status === 'refunded') !== (inv.paidAt !== null)) {
          v.push(`${tag} ${inv.id} status ${inv.status} inconsistent with paidAt ${inv.paidAt}`);
        }
        if (inv.createdAt < sub.createdAt) v.push(`${tag} ${inv.id} created before its subscription`);
      }
      // 4. never charged twice for one invoice
      const succeeded = attempts.filter((a) => a.outcome === 'succeeded');
      const perInvoice = new Set(succeeded.map((a) => a.invoiceId));
      if (perInvoice.size !== succeeded.length) v.push(`${tag} has more than one successful charge for an invoice`);
      // 5. at most one open invoice at a time
      if (invoices.filter((i) => i.status === 'open').length > 1) v.push(`${tag} has more than one open invoice`);
      // 6. audit trail agrees with current state
      const history = this.statusHistory(sub.id);
      if (history[history.length - 1] !== sub.status) {
        v.push(`${tag} audit log ends in '${history[history.length - 1]}'`);
      }
      // 7. timestamps are coherent
      if (sub.updatedAt < sub.createdAt) v.push(`${tag} updatedAt before createdAt`);
      // 8. side effects fire once per real state change
      const changes = this.audit(sub.id).filter((a) => a.fromStatus !== null && a.fromStatus !== a.toStatus).length;
      const createdActive = this.audit(sub.id)[0]?.toStatus === 'active' ? 1 : 0;
      if (this.notifications(sub.id).length !== changes + createdActive) {
        v.push(`${tag} ${this.notifications(sub.id).length} notifications for ${changes + createdActive} state changes`);
      }
    }

    // 9. idempotency keys are only reused for a retry after a timeout
    const all = this.repos.subscriptions.findAll().flatMap((s) => this.attempts(s.id));
    const byKey = new Map<string, string[]>();
    all.forEach((a) => byKey.set(a.idempotencyKey, [...(byKey.get(a.idempotencyKey) ?? []), a.outcome]));
    for (const [key, outcomes] of byKey) {
      if (outcomes.slice(0, -1).some((o) => o !== 'timeout')) v.push(`idempotency key ${key} reused after a definitive outcome`);
    }
    return v;
  }

  expectAllInvariantsHold(): void {
    expect(this.invariantViolations()).toEqual([]);
  }
}
