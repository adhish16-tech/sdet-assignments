import { TestEnvironment } from '../framework/TestEnvironment';

describe('Persistence & auditability', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = TestEnvironment.create();
  });

  describe('records match the API at every stage of the lifecycle', () => {
    afterEach(() => env.verify.expectAllInvariantsHold());

    it('trialing → past_due → active → canceled: API, DB and invariants agree at each checkpoint', async () => {
      const id = await env.given.trialingPro();
      await env.verify.expectApiMatchesDatabase(id);
      env.verify.expectAllInvariantsHold();

      env.provider.willDecline();
      await env.given.trialEndsAndBillingRuns();
      await env.verify.expectApiMatchesDatabase(id);
      env.verify.expectAllInvariantsHold();

      await env.api.runBilling();
      await env.verify.expectApiMatchesDatabase(id);
      env.verify.expectAllInvariantsHold();

      await env.api.cancel(id);
      await env.verify.expectApiMatchesDatabase(id);
      expect(env.verify.statusHistory(id)).toEqual(['trialing', 'past_due', 'active', 'canceled']);
    });

    it('a paid invoice sets paidAt and moves current_period_end forward by 30 days', async () => {
      const id = await env.given.trialingPro();
      await env.given.trialEndsAndBillingRuns();

      const sub = env.verify.subscription(id);
      const invoice = env.verify.latestInvoice(id);
      expect(invoice.paidAt).toBe(env.clock.now().toISOString());
      expect(Date.parse(sub.currentPeriodEnd) - Date.parse(invoice.paidAt!)).toBe(30 * 24 * 60 * 60 * 1000);
      expect(invoice.createdAt >= sub.createdAt).toBe(true);
    });

    it('cancellation voids the open invoice so nothing is billed later', async () => {
      // A trialing subscription whose first charge timed out has an open invoice.
      const id = await env.given.trialingPro();
      env.provider.willTimeout();
      await env.given.trialEndsAndBillingRuns();
      await env.api.cancel(id);

      expect(env.verify.invoices(id).map((i) => i.status)).toEqual(['void']);
      expect(env.verify.audit(id).map((a) => a.action)).toContain('invoice.voided');
    });

    it('retries exhausted: invoice is uncollectible, never paid, subscription canceled', async () => {
      const id = await env.given.pastDuePro();
      env.provider.willDecline(2);
      await env.api.runBilling();
      await env.api.runBilling();

      expect(env.verify.invoices(id)).toEqual([
        expect.objectContaining({ status: 'uncollectible', attemptCount: 3, paidAt: null }),
      ]);
      expect(env.verify.attempts(id).map((a) => a.outcome)).toEqual(['declined', 'declined', 'declined']);
      expect(env.verify.subscription(id)).toMatchObject({ status: 'canceled', canceledAt: expect.any(String) });
    });
  });

  describe('audit trail', () => {
    afterEach(() => env.verify.expectAllInvariantsHold());

    it('records who caused each change and which invoice/event it refers to', async () => {
      const id = await env.given.trialingPro();
      env.provider.willDecline();
      await env.given.trialEndsAndBillingRuns();
      const invoice = env.verify.openInvoice(id);
      const event = env.webhooks.succeeded(invoice);
      await env.webhooks.deliver(event);

      const transitions = env.verify
        .audit(id)
        .filter((a) => a.toStatus !== null)
        .map(({ fromStatus, toStatus, source, reference }) => ({ fromStatus, toStatus, source, reference }));

      expect(transitions).toEqual([
        { fromStatus: null, toStatus: 'trialing', source: 'api', reference: null },
        { fromStatus: 'trialing', toStatus: 'past_due', source: 'billing_run', reference: invoice.id },
        { fromStatus: 'past_due', toStatus: 'active', source: 'webhook', reference: event.eventId },
      ]);
    });

    it('audit sequence numbers and timestamps only move forward', async () => {
      const id = await env.given.activePro();
      env.clock.advanceDays(30);
      await env.api.runBilling();
      const rows = env.verify.audit(id);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].seq).toBeGreaterThan(rows[i - 1].seq);
        expect(rows[i].at >= rows[i - 1].at).toBe(true);
      }
    });
  });

  describe('webhook_events table', () => {
    afterEach(() => env.verify.expectAllInvariantsHold());

    it('stores every unique event with its outcome, including no-ops', async () => {
      const id = await env.given.canceledPro();
      const ignored = env.webhooks.event().withField('subscription_id', id).withField('invoice_id', 'inv_999');
      await env.webhooks.deliver(ignored);

      expect(env.verify.webhookEvent(ignored.eventId)).toMatchObject({
        outcome: 'ignored_unknown_reference',
        deliveryCount: 1,
      });
    });

    it('does NOT store requests that failed authentication or validation', async () => {
      const id = await env.given.pastDuePro();
      const forged = env.webhooks.succeeded(env.verify.openInvoice(id)).signedWithWrongSecret();
      await env.webhooks.deliver(forged);
      expect(env.verify.webhookEvent(forged.eventId)).toBeUndefined();
      expect(env.repos.webhookEvents.count()).toBe(0);
    });
  });

  describe('the invariant checker itself (guards against false positives)', () => {
    it('reports a subscription that is active with only a failed invoice', async () => {
      const id = await env.given.pastDuePro();
      // Deliberately corrupt the data the way a bug would.
      const row = env.repos.subscriptions.findById(id)!;
      env.repos.subscriptions.update({ ...row, status: 'active' });

      expect(env.verify.invariantViolations()).toEqual(
        expect.arrayContaining([
          `[${id} active] is active but has no paid invoice`,
          `[${id} active] audit log ends in 'past_due'`,
        ]),
      );
    });

    it('reports a canceled subscription that still has an open invoice', async () => {
      const id = await env.given.pastDuePro();
      const row = env.repos.subscriptions.findById(id)!;
      env.repos.subscriptions.update({ ...row, status: 'canceled', canceledAt: row.updatedAt });

      expect(env.verify.invariantViolations()).toContain(`[${id} canceled] still has an open invoice`);
    });

    it('reports an invoice billed at the wrong price', async () => {
      const id = await env.given.pastDuePro();
      const inv = env.verify.openInvoice(id);
      env.repos.invoices.update({ ...inv, amountCents: 100 });

      expect(env.verify.invariantViolations()).toContain(`[${id} past_due] ${inv.id} amount 100 != plan price`);
    });

    it('reads are copies: mutating a returned row cannot change the database', async () => {
      const id = await env.given.trialingPro();
      const row = env.verify.subscription(id);
      row.status = 'active';
      expect(env.verify.subscription(id).status).toBe('trialing');
    });
  });
});
