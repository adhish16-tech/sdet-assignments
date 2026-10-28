import {
  ALL_STATUSES,
  ALL_TRIGGERS,
  InvalidTransitionError,
  SubscriptionStateMachine,
} from '../../src/domain/SubscriptionStateMachine';
import { SubscriptionRequestBuilder } from '../framework/builders/SubscriptionRequestBuilder';
import { TestEnvironment } from '../framework/TestEnvironment';

describe('State machine — the transition table itself', () => {
  const machine = new SubscriptionStateMachine();

  it('contains exactly the lifecycle from the spec (plus the two documented self-loops)', () => {
    expect(machine.allowedTransitions()).toEqual(
      expect.arrayContaining([
        { from: 'trialing', trigger: 'CHARGE_SUCCEEDED', to: 'active' },
        { from: 'trialing', trigger: 'CHARGE_FAILED', to: 'past_due' },
        { from: 'trialing', trigger: 'CANCEL', to: 'canceled' },
        { from: 'active', trigger: 'CHARGE_FAILED', to: 'past_due' },
        { from: 'active', trigger: 'CANCEL', to: 'canceled' },
        { from: 'past_due', trigger: 'CHARGE_SUCCEEDED', to: 'active' },
        { from: 'past_due', trigger: 'RETRIES_EXHAUSTED', to: 'canceled' },
        // documented self-loops: renewal, and a failed retry with retries left
        { from: 'active', trigger: 'CHARGE_SUCCEEDED', to: 'active' },
        { from: 'past_due', trigger: 'CHARGE_FAILED', to: 'past_due' },
      ]),
    );
    expect(machine.allowedTransitions()).toHaveLength(9);
  });

  it('rejects every (status, trigger) pair that is not in the table', () => {
    const allowed = new Set(machine.allowedTransitions().map((t) => `${t.from}:${t.trigger}`));
    const pairs = ALL_STATUSES.flatMap((s) => ALL_TRIGGERS.map((t) => [s, t] as const));
    const illegal = pairs.filter(([s, t]) => !allowed.has(`${s}:${t}`));

    expect(illegal.length).toBe(7); // 16 pairs - 9 legal
    for (const [from, trigger] of illegal) {
      expect(() => machine.next(from, trigger)).toThrow(InvalidTransitionError);
    }
  });

  it('treats canceled as terminal', () => {
    for (const trigger of ALL_TRIGGERS) expect(machine.canApply('canceled', trigger)).toBe(false);
  });
});

describe('State machine — every lifecycle edge, driven through the real system', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = TestEnvironment.create();
  });
  afterEach(() => env.verify.expectAllInvariantsHold());

  describe('valid transitions', () => {
    it('trialing → active: trial ends and the first charge succeeds (billing run)', async () => {
      const id = await env.given.trialingPro();
      await env.given.trialEndsAndBillingRuns();
      await env.verify.expectState(id, 'active');
      expect(env.verify.latestInvoice(id)).toMatchObject({ status: 'paid', amountCents: 4900 });
    });

    it('trialing → active: charge timed out, then provider confirms via payment.succeeded webhook', async () => {
      const id = await env.given.trialingPro();
      env.provider.willTimeout();
      await env.given.trialEndsAndBillingRuns();
      await env.verify.expectState(id, 'trialing'); // unknown outcome: no state change yet

      await env.webhooks.deliver(env.webhooks.succeeded(env.verify.openInvoice(id)));
      await env.verify.expectState(id, 'active');
    });

    it('trialing → past_due: trial ends and the first charge is declined', async () => {
      const id = await env.given.trialingPro();
      env.provider.willDecline();
      await env.given.trialEndsAndBillingRuns();
      await env.verify.expectState(id, 'past_due');
    });

    it('active → past_due: a renewal charge is declined', async () => {
      const id = await env.given.activePro();
      env.provider.willDecline();
      env.clock.advanceDays(30);
      await env.api.runBilling();
      await env.verify.expectState(id, 'past_due');
    });

    it('active → past_due: provider reports payment.failed by webhook for a timed-out renewal', async () => {
      const id = await env.given.activePro();
      env.provider.willTimeout();
      env.clock.advanceDays(30);
      await env.api.runBilling();

      await env.webhooks.deliver(env.webhooks.failed(env.verify.openInvoice(id)));
      await env.verify.expectState(id, 'past_due');
    });

    it('past_due → active: the retry charge succeeds', async () => {
      const id = await env.given.pastDuePro();
      await env.api.runBilling(); // retry, mock succeeds by default
      await env.verify.expectState(id, 'active');
    });

    it('past_due → active: provider confirms payment by webhook', async () => {
      const id = await env.given.pastDuePro();
      await env.webhooks.deliver(env.webhooks.succeeded(env.verify.openInvoice(id)));
      await env.verify.expectState(id, 'active');
    });

    it('past_due → canceled: retries are exhausted (3 declines in total)', async () => {
      const id = await env.given.pastDuePro(); // decline #1
      env.provider.willDecline(2);
      await env.api.runBilling(); // decline #2
      await env.verify.expectState(id, 'past_due');
      await env.api.runBilling(); // decline #3 -> exhausted

      await env.verify.expectState(id, 'canceled');
      expect(env.verify.latestInvoice(id)).toMatchObject({ status: 'uncollectible', attemptCount: 3 });
    });

    it('active → canceled: customer cancels', async () => {
      const id = await env.given.activePro();
      expect((await env.api.cancel(id)).status).toBe(200);
      await env.verify.expectState(id, 'canceled');
    });

    it('trialing → canceled: customer cancels during the trial', async () => {
      const id = await env.given.trialingPro();
      expect((await env.api.cancel(id)).status).toBe(200);
      await env.verify.expectState(id, 'canceled');
    });
  });

  describe('invalid transitions are impossible', () => {
    it('canceled → active is impossible: a stray payment.succeeded webhook is ignored', async () => {
      const id = await env.given.trialingPro();
      env.provider.willTimeout();
      await env.given.trialEndsAndBillingRuns(); // leaves an open invoice
      const invoice = env.verify.openInvoice(id);
      await env.api.cancel(id); // invoice becomes void

      const res = await env.webhooks.deliver(env.webhooks.succeeded(invoice));

      expect(res.body.outcome).toBe('ignored_subscription_canceled');
      await env.verify.expectState(id, 'canceled');
      expect(env.verify.invoices(id).map((i) => i.status)).toEqual(['void']);
    });

    it('canceled → canceled is impossible: a second cancel is rejected with 409', async () => {
      const id = await env.given.canceledPro();
      expect((await env.api.cancel(id)).status).toBe(409);
    });

    it('past_due → canceled by API is not in the lifecycle, so it is rejected with 409', async () => {
      // Spec lists only trialing/active as cancellable by API. See TEST_STRATEGY.md "Questions for product".
      const id = await env.given.pastDuePro();
      const res = await env.api.cancel(id);
      expect(res.status).toBe(409);
      await env.verify.expectState(id, 'past_due');
    });

    it('active does not regress: payment.failed arriving AFTER payment.succeeded for the same invoice', async () => {
      const id = await env.given.pastDuePro();
      const invoice = env.verify.openInvoice(id);
      await env.webhooks.deliver(env.webhooks.succeeded(invoice));
      await env.verify.expectState(id, 'active');

      const late = await env.webhooks.deliver(env.webhooks.failed(invoice));

      expect(late.body.outcome).toBe('ignored_invoice_not_open');
      await env.verify.expectState(id, 'active');
      expect(env.verify.invoices(id)[0]).toMatchObject({ status: 'paid' });
    });

    it('canceled stays canceled after exhaustion, whatever arrives next', async () => {
      const id = await env.given.pastDuePro();
      env.provider.willDecline(2);
      await env.api.runBilling();
      await env.api.runBilling();
      const invoice = env.verify.latestInvoice(id);

      await env.webhooks.deliver(env.webhooks.succeeded(invoice));
      await env.webhooks.deliver(env.webhooks.failed(invoice));
      env.clock.advanceDays(60);
      await env.api.runBilling();

      await env.verify.expectState(id, 'canceled');
      expect(env.verify.statusHistory(id)).toEqual(['trialing', 'past_due', 'canceled']);
    });
  });

  describe('plan-specific rules', () => {
    it('Pro is not charged before day 14, and is charged 4900 on day 14', async () => {
      const id = await env.given.trialingPro();

      env.clock.advanceDays(13);
      await env.api.runBilling();
      expect(env.provider.callCount).toBe(0);
      await env.verify.expectState(id, 'trialing');

      env.clock.advanceDays(1);
      await env.api.runBilling();
      expect(env.provider.callCount).toBe(1);
      expect(env.provider.lastRequest().amountCents).toBe(4900);
    });

    it('Basic has no trial and is charged 1900 at sign-up', async () => {
      const res = await env.api.create(SubscriptionRequestBuilder.aSubscriptionRequest().forPlan('basic').build());
      expect(res.body.trial_ends_at).toBeNull();
      expect(env.provider.lastRequest().amountCents).toBe(1900);
    });

    it('the renewal is billed at the same plan price as the first charge', async () => {
      const id = await env.given.activePro();
      env.clock.advanceDays(30);
      await env.api.runBilling();
      expect(env.verify.invoices(id).map((i) => [i.amountCents, i.status])).toEqual([
        [4900, 'paid'],
        [4900, 'paid'],
      ]);
    });
  });
});
