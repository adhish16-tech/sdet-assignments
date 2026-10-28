import { CustomerBuilder } from '../framework/builders/CustomerBuilder';
import { SubscriptionRequestBuilder } from '../framework/builders/SubscriptionRequestBuilder';
import { TestEnvironment } from '../framework/TestEnvironment';

const aRequest = SubscriptionRequestBuilder.aSubscriptionRequest;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('API contract & validation', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = TestEnvironment.create();
  });
  afterEach(() => env.verify.expectAllInvariantsHold());

  describe('POST /subscriptions — success', () => {
    it('creates a Pro subscription in trialing with a 14-day trial and does not charge', async () => {
      const res = await env.api.create(aRequest().forPlan('pro').build());

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.stringMatching(/^sub_\d+$/),
        customer_id: 'cust_001',
        plan: 'pro',
        status: 'trialing',
        price_cents: 4900,
        currency: 'USD',
        trial_ends_at: expect.any(String),
        current_period_end: expect.any(String),
        canceled_at: null,
        created_at: expect.any(String),
      });
      const trialMs = Date.parse(res.body.trial_ends_at!) - Date.parse(res.body.created_at);
      expect(trialMs).toBe(14 * DAY_MS);
      expect(env.provider.callCount).toBe(0);
      await env.verify.expectApiMatchesDatabase(res.body.id);
    });

    it('creates a Basic subscription as active after one upfront charge', async () => {
      const res = await env.api.create(aRequest().forPlan('basic').build());

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ plan: 'basic', status: 'active', price_cents: 1900, trial_ends_at: null });
      expect(env.provider.callCount).toBe(1);
      expect(env.verify.invoices(res.body.id)).toEqual([
        expect.objectContaining({ amountCents: 1900, status: 'paid', attemptCount: 1 }),
      ]);
      await env.verify.expectApiMatchesDatabase(res.body.id);
    });

    it('GET /subscriptions/:id returns the stored subscription', async () => {
      const id = await env.given.trialingPro();
      const res = await env.api.get(id);
      expect(res.status).toBe(200);
      await env.verify.expectApiMatchesDatabase(id);
    });

    it('GET /subscriptions/:id returns 404 for an unknown id', async () => {
      const res = await env.api.get('sub_999');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('subscription_not_found');
    });
  });

  describe('POST /subscriptions — validation failures persist nothing and never charge', () => {
    afterEach(() => {
      env.verify.expectNothingPersisted();
      expect(env.provider.callCount).toBe(0);
    });

    it.each([
      ['customer_id' as const, 'customer_id is required'],
      ['plan' as const, 'plan is required'],
      ['payment_method_id' as const, 'payment_method_id is required'],
    ])('rejects a missing %s with 400', async (field, message) => {
      const res = await env.api.create(aRequest().without(field).build());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.details).toContain(message);
    });

    it('rejects an unknown plan with 400', async () => {
      const res = await env.api.create(aRequest().forPlan('platinum').build());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unknown_plan');
    });

    it('rejects an unknown customer with 404', async () => {
      const res = await env.api.create(aRequest().forCustomer('cust_ghost').build());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('customer_not_found');
    });

    it('rejects a payment method that belongs to someone else', async () => {
      env.seedCustomer(CustomerBuilder.aCustomer().withId('cust_002').withPaymentMethods('pm_test_mc_5555'));
      const res = await env.api.create(aRequest().forCustomer('cust_001').withPaymentMethod('pm_test_mc_5555').build());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_payment_method');
    });

    it('rejects a badly formatted payment method id', async () => {
      const res = await env.api.create(aRequest().withPaymentMethod('4242424242424242').build());
      expect(res.status).toBe(400);
      expect(res.body.details).toContain('payment_method_id must start with pm_');
    });

    it('rejects a body that is not JSON', async () => {
      const res = await env.api.createRaw('{"customer_id": ');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('malformed_json');
    });
  });

  describe('POST /subscriptions/:id/cancel', () => {
    it('cancels a trialing subscription', async () => {
      const id = await env.given.trialingPro();
      const res = await env.api.cancel(id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('canceled');
      expect(res.body.canceled_at).not.toBeNull();
      await env.verify.expectApiMatchesDatabase(id);
    });

    it('returns 409 when canceling an already-canceled subscription and changes nothing', async () => {
      const id = await env.given.canceledPro();
      const before = { row: env.verify.subscription(id), audit: env.verify.audit(id) };

      const res = await env.api.cancel(id);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('invalid_transition');
      expect(env.verify.subscription(id)).toEqual(before.row);
      expect(env.verify.audit(id)).toEqual(before.audit);
    });

    it('returns 404 for an unknown subscription', async () => {
      expect((await env.api.cancel('sub_999')).status).toBe(404);
    });
  });

  describe('POST /webhooks/payment-provider — request handling', () => {
    let subId: string;
    beforeEach(async () => {
      subId = await env.given.pastDuePro();
    });

    it('accepts a correctly signed event and applies it', async () => {
      const res = await env.webhooks.deliver(env.webhooks.succeeded(env.verify.openInvoice(subId)));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ outcome: 'applied', duplicate: false });
    });

    it.each([
      ['no signature header', (b: any) => b.unsigned(), 'missing_signature'],
      ['a signature made with the wrong secret', (b: any) => b.signedWithWrongSecret(), 'invalid_signature'],
      ['a body changed after signing', (b: any) => b.withTamperedBody(), 'invalid_signature'],
    ])('rejects %s with 401 and records nothing', async (_name, forge, error) => {
      const invoice = env.verify.openInvoice(subId);
      const builder = forge(env.webhooks.succeeded(invoice));

      const res = await env.webhooks.deliver(builder);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe(error);
      expect(env.verify.webhookEvent(builder.eventId)).toBeUndefined();
      await env.verify.expectState(subId, 'past_due');
    });

    it.each([
      ['a body that is not JSON', (b: any) => b.withRawBody('not-json{')],
      ['a missing event_id', (b: any) => b.withoutField('event_id')],
      ['an unknown event type', (b: any) => b.withField('type', 'payment.teleported')],
      ['a non-integer amount', (b: any) => b.withField('amount', '49.00')],
    ])('rejects %s with 400 (signed correctly)', async (_name, malform) => {
      const res = await env.webhooks.deliver(malform(env.webhooks.succeeded(env.verify.openInvoice(subId))));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('malformed_payload');
      await env.verify.expectState(subId, 'past_due');
    });

    it('acknowledges an event for an unknown invoice without changing anything', async () => {
      const res = await env.webhooks.deliver(env.webhooks.event().withField('invoice_id', 'inv_999').withField('subscription_id', subId));
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('ignored_unknown_reference');
      await env.verify.expectState(subId, 'past_due');
    });

    it('rejects an event whose amount does not match the invoice', async () => {
      const invoice = env.verify.openInvoice(subId);
      const res = await env.webhooks.deliver(env.webhooks.succeeded(invoice).withAmount(100));
      expect(res.body.outcome).toBe('rejected_amount_mismatch');
      expect(env.verify.openInvoice(subId).status).toBe('open');
      await env.verify.expectState(subId, 'past_due');
    });
  });
});
