import { SubscriptionRequestBuilder } from '../framework/builders/SubscriptionRequestBuilder';
import { TestEnvironment } from '../framework/TestEnvironment';

/**
 * Whole customer journeys: HTTP request or webhook in → service → database
 * and provider out. Each step asserts what a real customer/finance team would care about.
 */
describe('End-to-end journeys', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = TestEnvironment.create();
  });
  afterEach(() => env.verify.expectAllInvariantsHold());

  it('happy path: sign up for Pro → trial → paid → renewed → canceled → stray webhook ignored', async () => {
    // Sign up
    const created = await env.api.create(SubscriptionRequestBuilder.aSubscriptionRequest().forPlan('pro').build());
    const id = created.body.id;
    expect(created.body.status).toBe('trialing');
    expect(env.provider.callCount).toBe(0);

    // Trial ends → first charge
    await env.given.trialEndsAndBillingRuns();
    await env.verify.expectState(id, 'active');
    expect(env.provider.lastRequest()).toMatchObject({ amountCents: 4900, customerId: 'cust_001' });

    // Month 2 renewal
    env.clock.advanceDays(30);
    await env.api.runBilling();
    expect(env.verify.invoices(id).map((i) => i.status)).toEqual(['paid', 'paid']);

    // Cancel
    await env.api.cancel(id);
    await env.verify.expectState(id, 'canceled');

    // A late webhook for an old invoice cannot bring it back, and billing stops
    const late = await env.webhooks.deliver(env.webhooks.succeeded(env.verify.latestInvoice(id)));
    expect(late.body.outcome).toBe('ignored_subscription_canceled');
    env.clock.advanceDays(30);
    await env.api.runBilling();

    await env.verify.expectState(id, 'canceled');
    expect(env.provider.callCount).toBe(2);
    expect(env.verify.notifications(id).map((n) => n.kind)).toEqual(['subscription_activated', 'subscription_canceled']);
  });

  it('recovery: decline → past_due → retry times out → provider confirms by webhook → active', async () => {
    const id = await env.given.trialingPro();

    env.provider.willDecline();
    await env.given.trialEndsAndBillingRuns();
    await env.verify.expectState(id, 'past_due');

    env.provider.willTimeout();
    await env.api.runBilling();
    await env.verify.expectState(id, 'past_due'); // outcome unknown, nothing changes

    const invoice = env.verify.openInvoice(id);
    await env.webhooks.deliverRepeatedly(env.webhooks.succeeded(invoice), 2); // provider redelivers too

    await env.verify.expectState(id, 'active');
    expect(env.verify.attempts(id).map((a) => a.outcome)).toEqual(['declined', 'timeout']);
    expect(env.verify.invoices(id)).toEqual([expect.objectContaining({ status: 'paid' })]);
    expect(env.verify.statusHistory(id)).toEqual(['trialing', 'past_due', 'active']);
  });

  it('dunning: three declines cancel the subscription and nothing is ever charged again', async () => {
    const id = await env.given.trialingPro();
    env.provider.willDecline(3);

    await env.given.trialEndsAndBillingRuns();
    await env.api.runBilling();
    await env.api.runBilling();

    await env.verify.expectState(id, 'canceled');
    expect(env.verify.notifications(id).map((n) => n.kind)).toEqual(['payment_failed', 'subscription_canceled']);

    env.provider.resetCalls();
    env.clock.advanceDays(45);
    await env.api.runBilling();
    expect(env.provider.charge).not.toHaveBeenCalled();
  });
});
