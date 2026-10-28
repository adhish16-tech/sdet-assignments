import { SubscriptionRequestBuilder } from '../framework/builders/SubscriptionRequestBuilder';
import { TestEnvironment } from '../framework/TestEnvironment';

const aRequest = SubscriptionRequestBuilder.aSubscriptionRequest;

describe('Payment provider interaction (mocked)', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = TestEnvironment.create();
  });
  afterEach(() => env.verify.expectAllInvariantsHold());

  describe('what we send to the provider', () => {
    it('sends customer, payment method, amount, currency, invoice and idempotency key', async () => {
      const res = await env.api.create(aRequest().forPlan('basic').build());
      const invoice = env.verify.latestInvoice(res.body.id);

      expect(env.provider.charge).toHaveBeenCalledTimes(1);
      expect(env.provider.charge).toHaveBeenCalledWith({
        customerId: 'cust_001',
        paymentMethodId: 'pm_test_visa_4242',
        amountCents: 1900,
        currency: 'USD',
        invoiceId: invoice.id,
        idempotencyKey: `${invoice.id}:attempt-1`,
      });
    });

    it('the attempt row stores the same idempotency key that was sent', async () => {
      const id = await env.given.activePro();
      const [attempt] = env.verify.attempts(id);
      expect(attempt).toMatchObject({ outcome: 'succeeded', idempotencyKey: `${attempt.invoiceId}:attempt-1` });
      expect(attempt.providerChargeId).toMatch(/^ch_mock_/);
    });

    it('each retry after a decline uses a new idempotency key (it is a genuinely new attempt)', async () => {
      const id = await env.given.trialingPro();
      env.provider.willDecline(3);
      await env.given.trialEndsAndBillingRuns();
      await env.api.runBilling();
      await env.api.runBilling();

      const inv = env.verify.latestInvoice(id).id;
      expect(env.provider.requests.map((r) => r.idempotencyKey)).toEqual([
        `${inv}:attempt-1`,
        `${inv}:attempt-2`,
        `${inv}:attempt-3`,
      ]);
    });
  });

  describe('success / decline / timeout', () => {
    it('success at sign-up: one charge, one paid invoice, active', async () => {
      const res = await env.api.create(aRequest().forPlan('basic').build());
      expect(res.body.status).toBe('active');
      expect(env.verify.attempts(res.body.id).map((a) => a.outcome)).toEqual(['succeeded']);
    });

    it('decline at sign-up: 402, provider called once, nothing persisted', async () => {
      env.provider.willDecline();
      const res = await env.api.create(aRequest().forPlan('basic').build());

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('payment_declined');
      expect(env.provider.callCount).toBe(1);
      env.verify.expectNothingPersisted();
    });

    it('timeout at sign-up: 503, nothing persisted', async () => {
      env.provider.willTimeout();
      const res = await env.api.create(aRequest().forPlan('basic').build());

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('payment_provider_unavailable');
      env.verify.expectNothingPersisted();
    });

    it('decline at trial end: past_due, failure recorded, NO success record', async () => {
      const id = await env.given.trialingPro();
      env.provider.willDecline();
      await env.given.trialEndsAndBillingRuns();

      await env.verify.expectState(id, 'past_due');
      expect(env.verify.attempts(id)).toEqual([expect.objectContaining({ outcome: 'declined', declineCode: 'card_declined' })]);
      expect(env.verify.invoices(id)).toEqual([expect.objectContaining({ status: 'open', attemptCount: 1, paidAt: null })]);
      expect(env.verify.notifications(id).map((n) => n.kind)).toEqual(['payment_failed']);
    });

    it('timeout at trial end: state unchanged, invoice stays open, outcome recorded as unknown', async () => {
      const id = await env.given.trialingPro();
      env.provider.willTimeout();
      await env.given.trialEndsAndBillingRuns();

      await env.verify.expectState(id, 'trialing');
      expect(env.verify.attempts(id).map((a) => a.outcome)).toEqual(['timeout']);
      expect(env.verify.openInvoice(id).attemptCount).toBe(0);
    });

    it('retry after a timeout REUSES the idempotency key, so the provider cannot double-charge', async () => {
      const id = await env.given.trialingPro();
      env.provider.willTimeout();
      await env.given.trialEndsAndBillingRuns();
      await env.api.runBilling(); // retry succeeds

      const [first, retry] = env.provider.requests;
      expect(retry.idempotencyKey).toBe(first.idempotencyKey);
      expect(retry.invoiceId).toBe(first.invoiceId);
      await env.verify.expectState(id, 'active');
    });
  });

  describe('when the provider must NOT be called', () => {
    it('rejected creation (validation error)', async () => {
      await env.api.create(aRequest().forPlan('nope').build());
      expect(env.provider.charge).not.toHaveBeenCalled();
    });

    it('creating a trial subscription', async () => {
      await env.api.create(aRequest().forPlan('pro').build());
      expect(env.provider.charge).not.toHaveBeenCalled();
    });

    it('billing run before anything is due', async () => {
      await env.given.trialingPro();
      await env.given.activeBasic();
      env.clock.advanceDays(1);
      await env.api.runBilling();
      expect(env.provider.charge).not.toHaveBeenCalled();
    });

    it('replayed webhooks', async () => {
      const id = await env.given.pastDuePro();
      await env.webhooks.deliverRepeatedly(env.webhooks.succeeded(env.verify.openInvoice(id)), 3);
      expect(env.provider.charge).not.toHaveBeenCalled();
    });

    it('a canceled subscription, even long after its period ended', async () => {
      const id = await env.given.activePro();
      await env.api.cancel(id);
      env.clock.advanceDays(90);
      await env.api.runBilling();
      expect(env.provider.charge).not.toHaveBeenCalled();
    });

    it('an invoice already confirmed by webhook after a timeout', async () => {
      const id = await env.given.trialingPro();
      env.provider.willTimeout();
      await env.given.trialEndsAndBillingRuns();
      await env.webhooks.deliver(env.webhooks.succeeded(env.verify.openInvoice(id)));
      env.provider.resetCalls();

      await env.api.runBilling();
      expect(env.provider.charge).not.toHaveBeenCalled();
    });
  });

  it('is called exactly once per genuine billing attempt across a full journey', async () => {
    const id = await env.given.trialingPro();
    env.provider.willDecline(); // trial end: decline
    await env.given.trialEndsAndBillingRuns(); // attempt 1
    await env.api.runBilling(); // attempt 2 (success)
    await env.api.runBilling(); // nothing due
    env.clock.advanceDays(30);
    await env.api.runBilling(); // renewal

    expect(env.provider.callCount).toBe(3);
    expect(env.verify.attempts(id)).toHaveLength(3);
  });
});
