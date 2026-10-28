import { TestEnvironment } from '../framework/TestEnvironment';

describe('Webhooks — idempotency, duplicates and ordering', () => {
  let env: TestEnvironment;
  let subId: string;

  beforeEach(async () => {
    env = TestEnvironment.create();
    subId = await env.given.pastDuePro(); // has one open invoice waiting for payment
  });
  afterEach(() => env.verify.expectAllInvariantsHold());

  describe('same event_id delivered more than once', () => {
    it('applies the transition exactly once', async () => {
      const event = env.webhooks.succeeded(env.verify.openInvoice(subId));

      const [first, second] = await env.webhooks.deliverRepeatedly(event, 2);

      expect(first.body).toEqual({ outcome: 'applied', duplicate: false });
      expect(second.body).toEqual({ outcome: 'applied', duplicate: true });
      const transitionsToActive = env.verify.audit(subId).filter((a) => a.toStatus === 'active');
      expect(transitionsToActive).toHaveLength(1);
    });

    it('does not create a second invoice, payment or provider charge', async () => {
      const invoice = env.verify.openInvoice(subId);
      const attemptsBefore = env.verify.attempts(subId).length;

      await env.webhooks.deliverRepeatedly(env.webhooks.succeeded(invoice), 5);

      expect(env.verify.invoices(subId)).toEqual([expect.objectContaining({ id: invoice.id, status: 'paid' })]);
      expect(env.verify.attempts(subId)).toHaveLength(attemptsBefore);
      expect(env.provider.callCount).toBe(0);
    });

    it('fires the "activated" notification once', async () => {
      await env.webhooks.deliverRepeatedly(env.webhooks.succeeded(env.verify.openInvoice(subId)), 3);
      const activated = env.verify.notifications(subId).filter((n) => n.kind === 'subscription_activated');
      expect(activated).toHaveLength(1);
    });

    it('records the event once, with every redelivery counted', async () => {
      const event = env.webhooks.succeeded(env.verify.openInvoice(subId));
      await env.webhooks.deliverRepeatedly(event, 3);

      expect(env.verify.webhookEvent(event.eventId)).toMatchObject({
        outcome: 'applied',
        deliveryCount: 3,
        type: 'payment.succeeded',
      });
    });

    it('a duplicated payment.failed only counts as one failed attempt', async () => {
      const event = env.webhooks.failed(env.verify.openInvoice(subId));
      await env.webhooks.deliverRepeatedly(event, 3);

      // 1 decline from setup + 1 from this event. Three would have canceled the subscription.
      expect(env.verify.openInvoice(subId).attemptCount).toBe(2);
      await env.verify.expectState(subId, 'past_due');
    });

    it('duplicate of an ignored event stays ignored (outcome is remembered, not recomputed)', async () => {
      const invoice = env.verify.openInvoice(subId);
      const wrongAmount = env.webhooks.succeeded(invoice).withAmount(1);
      await env.webhooks.deliver(wrongAmount.withEventId('evt_bad_amount'));
      const again = await env.webhooks.deliver(wrongAmount);

      expect(again.body).toEqual({ outcome: 'rejected_amount_mismatch', duplicate: true });
      await env.verify.expectState(subId, 'past_due');
    });
  });

  describe('different event_ids describing the same payment', () => {
    it('a second payment.succeeded for an already-paid invoice is a no-op', async () => {
      const invoice = env.verify.openInvoice(subId);
      await env.webhooks.deliver(env.webhooks.succeeded(invoice));
      const second = await env.webhooks.deliver(env.webhooks.succeeded(invoice)); // new event_id

      expect(second.body).toEqual({ outcome: 'ignored_invoice_not_open', duplicate: false });
      expect(env.verify.invoices(subId).filter((i) => i.status === 'paid')).toHaveLength(1);
    });
  });

  describe('out-of-order delivery', () => {
    it('failed-after-succeeded does not regress an active subscription', async () => {
      const invoice = env.verify.openInvoice(subId);
      await env.webhooks.deliver(env.webhooks.succeeded(invoice));
      await env.webhooks.deliver(env.webhooks.failed(invoice));

      await env.verify.expectState(subId, 'active');
      expect(env.verify.notifications(subId).map((n) => n.kind)).toEqual(['payment_failed', 'subscription_activated']);
    });

    it('succeeded-after-failed recovers the subscription (the later truth wins while the invoice is open)', async () => {
      const invoice = env.verify.openInvoice(subId);
      await env.webhooks.deliver(env.webhooks.failed(invoice));
      await env.webhooks.deliver(env.webhooks.succeeded(invoice));
      await env.verify.expectState(subId, 'active');
    });
  });

  describe('refunds', () => {
    it('marks the invoice refunded without changing lifecycle state, once', async () => {
      const invoice = env.verify.openInvoice(subId);
      await env.webhooks.deliver(env.webhooks.succeeded(invoice));

      const refund = env.webhooks.refunded(invoice);
      await env.webhooks.deliverRepeatedly(refund, 2);

      expect(env.verify.invoices(subId)[0].status).toBe('refunded');
      expect(env.verify.audit(subId).filter((a) => a.action === 'invoice.refunded')).toHaveLength(1);
      await env.verify.expectState(subId, 'active');
    });
  });

  describe('concurrent delivery (bonus)', () => {
    it('five parallel deliveries of one event apply it exactly once', async () => {
      const event = env.webhooks.succeeded(env.verify.openInvoice(subId));

      const responses = await env.webhooks.deliverConcurrently(event, 5);

      expect(responses.filter((r) => r.body.duplicate === false)).toHaveLength(1);
      expect(env.verify.webhookEvent(event.eventId)?.deliveryCount).toBe(5);
      expect(env.verify.audit(subId).filter((a) => a.toStatus === 'active')).toHaveLength(1);
      // NOTE: the in-memory fixture handles each request synchronously, so this proves
      // the check-then-insert logic, not database-level locking. See TEST_STRATEGY.md.
    });
  });
});
