import { PlanCatalog, PlanPolicy } from '../domain/plans';
import { InvalidTransitionError, SubscriptionStateMachine, Trigger } from '../domain/SubscriptionStateMachine';
import { InvoiceRow, SubscriptionRow, WebhookOutcome } from '../persistence/entities';
import { Repositories } from '../persistence/repositories';
import { ChargeRequest, PaymentProvider, ProviderTimeoutError } from '../payment/PaymentProvider';
import { Clock } from './Clock';
import { ServiceError } from './errors';

/** A subscription is canceled after this many definitive (declined) attempts on one invoice. */
export const MAX_PAYMENT_ATTEMPTS = 3;

export interface CreateSubscriptionInput {
  customer_id?: unknown;
  plan?: unknown;
  payment_method_id?: unknown;
}

export interface ProviderPaymentEvent {
  event_id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'payment.refunded';
  subscription_id: string;
  invoice_id: string;
  amount: number;
  currency: string;
}

type Source = 'api' | 'billing_run' | 'webhook';

/**
 * The minimal Subscription & Billing service (the system under test).
 * Every dependency is injected: repositories, payment provider, clock.
 */
export class SubscriptionService {
  private readonly stateMachine = new SubscriptionStateMachine();

  constructor(
    private readonly repos: Repositories,
    private readonly provider: PaymentProvider,
    private readonly plans: PlanCatalog,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------- create

  async create(input: CreateSubscriptionInput): Promise<SubscriptionRow> {
    const { customerId, planCode, paymentMethodId } = this.validateCreateInput(input);

    const plan = this.plans.find(planCode);
    if (!plan) throw new ServiceError(400, 'unknown_plan', `Plan '${planCode}' does not exist`);

    const customer = this.repos.customers.findById(customerId);
    if (!customer) throw new ServiceError(404, 'customer_not_found', `Customer '${customerId}' not found`);

    if (!customer.paymentMethodIds.includes(paymentMethodId)) {
      throw new ServiceError(400, 'invalid_payment_method', 'Payment method does not belong to customer');
    }

    const now = this.clock.now();
    const subscription: SubscriptionRow = {
      id: this.repos.db.nextId('sub'),
      customerId,
      paymentMethodId,
      plan: plan.code,
      priceCents: plan.priceCents,
      currency: plan.currency,
      status: 'trialing',
      trialEndsAt: plan.requiresUpfrontCharge() ? null : plan.firstChargeAt(now).toISOString(),
      currentPeriodEnd: plan.firstChargeAt(now).toISOString(),
      canceledAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    if (!plan.requiresUpfrontCharge()) {
      // Trial plan: no charge now. Initial state is decided by the plan policy.
      this.repos.subscriptions.insert(subscription);
      this.audit(subscription.id, 'created', null, 'trialing', 'api', null);
      return subscription;
    }

    // Upfront plan: charge FIRST, persist only if the money is confirmed.
    // A declined or timed-out sign-up leaves no subscription/invoice rows behind.
    const invoice = this.newInvoice(subscription.id, plan, now);
    const request = this.chargeRequest(subscription, invoice);
    let result;
    try {
      result = await this.provider.charge(request);
    } catch (err) {
      if (err instanceof ProviderTimeoutError) {
        throw new ServiceError(503, 'payment_provider_unavailable', 'Payment provider timed out; please retry');
      }
      throw err;
    }
    if (result.status === 'declined') {
      throw new ServiceError(402, 'payment_declined', `Payment declined: ${result.declineCode}`);
    }

    subscription.status = 'active';
    subscription.currentPeriodEnd = plan.nextPeriodEnd(now).toISOString();
    invoice.status = 'paid';
    invoice.attemptCount = 1;
    invoice.paidAt = now.toISOString();

    this.repos.subscriptions.insert(subscription);
    this.repos.invoices.insert(invoice);
    this.repos.paymentAttempts.insert({
      id: this.repos.db.nextId('pay'),
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      attemptNumber: 1,
      idempotencyKey: request.idempotencyKey,
      outcome: 'succeeded',
      providerChargeId: result.providerChargeId,
      declineCode: null,
      createdAt: now.toISOString(),
    });
    this.audit(subscription.id, 'created', null, 'active', 'api', invoice.id);
    this.repos.notifications.record({ subscriptionId: subscription.id, kind: 'subscription_activated', at: now.toISOString() });
    return subscription;
  }

  // ---------------------------------------------------------------- read

  get(id: string): SubscriptionRow {
    const sub = this.repos.subscriptions.findById(id);
    if (!sub) throw new ServiceError(404, 'subscription_not_found', `Subscription '${id}' not found`);
    return sub;
  }

  // ---------------------------------------------------------------- cancel

  cancel(id: string): SubscriptionRow {
    const sub = this.get(id);
    const updated = this.transition(sub, 'CANCEL', 'api', null);

    // Stop future billing: any unpaid invoice is voided.
    for (const inv of this.repos.invoices.findBySubscription(id).filter((i) => i.status === 'open')) {
      this.repos.invoices.update({ ...inv, status: 'void', updatedAt: this.nowIso() });
      this.audit(id, 'invoice.voided', null, null, 'api', inv.id);
    }
    return updated;
  }

  // ---------------------------------------------------------------- billing run

  /**
   * The scheduled billing job (in production: a cron). Bills every subscription
   * whose period has ended, and retries past_due ones. Returns ids it touched.
   */
  async runBillingCycle(): Promise<string[]> {
    const now = this.clock.now();
    const touched: string[] = [];

    for (const sub of this.repos.subscriptions.findAll()) {
      if (sub.status === 'canceled') continue;

      // Retry an existing open invoice (after a decline or a timeout) before creating a new one.
      let invoice = this.repos.invoices.findOpenForSubscription(sub.id);
      if (!invoice) {
        if (sub.status === 'past_due') continue; // nothing to retry
        if (new Date(sub.currentPeriodEnd) > now) continue; // not due yet
        invoice = this.newInvoice(sub.id, this.plans.get(sub.plan), now);
        this.repos.invoices.insert(invoice);
        this.audit(sub.id, 'invoice.created', null, null, 'billing_run', invoice.id);
      }

      await this.attemptCharge(sub, invoice);
      touched.push(sub.id);
    }
    return touched;
  }

  // ---------------------------------------------------------------- webhook events

  /** Applies an authenticated, de-duplicated provider event. Never throws for business reasons. */
  applyProviderEvent(evt: ProviderPaymentEvent): WebhookOutcome {
    const sub = this.repos.subscriptions.findById(evt.subscription_id);
    const invoice = this.repos.invoices.findById(evt.invoice_id);
    if (!sub || !invoice || invoice.subscriptionId !== sub.id) return 'ignored_unknown_reference';

    if (sub.status === 'canceled') return 'ignored_subscription_canceled';
    if (evt.amount !== invoice.amountCents || evt.currency !== invoice.currency) return 'rejected_amount_mismatch';

    switch (evt.type) {
      case 'payment.succeeded':
        if (invoice.status !== 'open') return 'ignored_invoice_not_open';
        return this.markPaid(sub, invoice, 'webhook', evt.event_id);

      case 'payment.failed':
        // Out-of-order protection: a failure for an invoice already paid is stale news.
        if (invoice.status !== 'open') return 'ignored_invoice_not_open';
        return this.recordDecline(sub, invoice, 'webhook', evt.event_id);

      case 'payment.refunded':
        if (invoice.status !== 'paid') return 'ignored_invoice_not_open';
        this.repos.invoices.update({ ...invoice, status: 'refunded', updatedAt: this.nowIso() });
        this.audit(sub.id, 'invoice.refunded', null, null, 'webhook', evt.event_id);
        return 'applied'; // assumption: a refund does not change lifecycle state
    }
  }

  // ---------------------------------------------------------------- internals

  private async attemptCharge(sub: SubscriptionRow, invoice: InvoiceRow): Promise<void> {
    const request = this.chargeRequest(sub, invoice);
    const attemptNumber = invoice.attemptCount + 1;
    const base = {
      invoiceId: invoice.id,
      subscriptionId: sub.id,
      attemptNumber,
      idempotencyKey: request.idempotencyKey,
      createdAt: this.nowIso(),
    };

    try {
      const result = await this.provider.charge(request);
      if (result.status === 'succeeded') {
        this.repos.paymentAttempts.insert({ ...base, id: this.repos.db.nextId('pay'), outcome: 'succeeded', providerChargeId: result.providerChargeId, declineCode: null });
        this.markPaid(sub, { ...invoice, attemptCount: attemptNumber }, 'billing_run', invoice.id);
      } else {
        this.repos.paymentAttempts.insert({ ...base, id: this.repos.db.nextId('pay'), outcome: 'declined', providerChargeId: null, declineCode: result.declineCode });
        this.recordDecline(sub, invoice, 'billing_run', invoice.id);
      }
    } catch (err) {
      if (!(err instanceof ProviderTimeoutError)) throw err;
      // Outcome UNKNOWN: record it, keep the invoice open, do NOT change state.
      // The attempt number is not consumed, so the next retry reuses the same
      // idempotency key and the provider cannot charge twice.
      this.repos.paymentAttempts.insert({ ...base, id: this.repos.db.nextId('pay'), outcome: 'timeout', providerChargeId: null, declineCode: null });
      this.audit(sub.id, 'charge.timeout', null, null, 'billing_run', invoice.id);
    }
  }

  private markPaid(sub: SubscriptionRow, invoice: InvoiceRow, source: Source, reference: string): WebhookOutcome {
    if (!this.stateMachine.canApply(sub.status, 'CHARGE_SUCCEEDED')) return 'ignored_invalid_transition';
    const now = this.nowIso();
    this.repos.invoices.update({ ...invoice, status: 'paid', paidAt: now, updatedAt: now });
    this.audit(sub.id, 'invoice.paid', null, null, source, invoice.id);
    const next = this.transition(sub, 'CHARGE_SUCCEEDED', source, reference);
    this.repos.subscriptions.update({
      ...next,
      currentPeriodEnd: this.plans.get(sub.plan).nextPeriodEnd(this.clock.now()).toISOString(),
    });
    return 'applied';
  }

  private recordDecline(sub: SubscriptionRow, invoice: InvoiceRow, source: Source, reference: string): WebhookOutcome {
    if (!this.stateMachine.canApply(sub.status, 'CHARGE_FAILED')) return 'ignored_invalid_transition';
    const attempts = invoice.attemptCount + 1;
    const exhausted = attempts >= MAX_PAYMENT_ATTEMPTS;
    this.repos.invoices.update({
      ...invoice,
      attemptCount: attempts,
      status: exhausted ? 'uncollectible' : 'open',
      updatedAt: this.nowIso(),
    });
    const afterFailure = this.transition(sub, 'CHARGE_FAILED', source, reference);
    if (exhausted) this.transition(afterFailure, 'RETRIES_EXHAUSTED', source, reference);
    return 'applied';
  }

  /**
   * THE ONLY PLACE a subscription's status changes after creation.
   * Asks the state machine, persists, writes the audit row, fires notifications.
   */
  private transition(sub: SubscriptionRow, trigger: Trigger, source: Source, reference: string | null): SubscriptionRow {
    let to;
    try {
      to = this.stateMachine.next(sub.status, trigger);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ServiceError(409, 'invalid_transition', err.message);
      }
      throw err;
    }
    const now = this.nowIso();
    const updated: SubscriptionRow = {
      ...sub,
      status: to,
      canceledAt: to === 'canceled' ? now : sub.canceledAt,
      updatedAt: now,
    };
    this.repos.subscriptions.update(updated);
    this.audit(sub.id, `transition:${trigger}`, sub.status, to, source, reference);

    if (sub.status !== to) {
      const kind =
        to === 'active' ? 'subscription_activated' : to === 'past_due' ? 'payment_failed' : 'subscription_canceled';
      this.repos.notifications.record({ subscriptionId: sub.id, kind, at: now });
    }
    return updated;
  }

  private newInvoice(subscriptionId: string, plan: PlanPolicy, at: Date): InvoiceRow {
    return {
      id: this.repos.db.nextId('inv'),
      subscriptionId,
      amountCents: plan.priceCents,
      currency: plan.currency,
      status: 'open',
      attemptCount: 0,
      paidAt: null,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    };
  }

  private chargeRequest(sub: SubscriptionRow, invoice: InvoiceRow): ChargeRequest {
    return {
      customerId: sub.customerId,
      paymentMethodId: sub.paymentMethodId,
      amountCents: invoice.amountCents,
      currency: invoice.currency,
      invoiceId: invoice.id,
      idempotencyKey: `${invoice.id}:attempt-${invoice.attemptCount + 1}`,
    };
  }

  private validateCreateInput(input: CreateSubscriptionInput) {
    const details: string[] = [];
    const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
    if (!isNonEmpty(input.customer_id)) details.push('customer_id is required');
    if (!isNonEmpty(input.plan)) details.push('plan is required');
    if (!isNonEmpty(input.payment_method_id)) details.push('payment_method_id is required');
    else if (!input.payment_method_id.startsWith('pm_')) details.push('payment_method_id must start with pm_');
    if (details.length) throw new ServiceError(400, 'validation_error', 'Invalid request body', details);
    return {
      customerId: input.customer_id as string,
      planCode: input.plan as string,
      paymentMethodId: input.payment_method_id as string,
    };
  }

  private audit(subscriptionId: string, action: string, from: SubscriptionRow['status'] | null, to: SubscriptionRow['status'] | null, source: Source, reference: string | null) {
    this.repos.auditLog.append({ subscriptionId, action, fromStatus: from, toStatus: to, source, reference, at: this.nowIso() });
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }
}
