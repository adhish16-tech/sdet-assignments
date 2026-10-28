import { PlanCatalog } from '../../src/domain/plans';
import { TestEnvironment, TEST_WEBHOOK_SECRET } from '../framework/TestEnvironment';

/**
 * Setup / schema validation: proves the environment a test starts from is what the docs say.
 * Run alone with: npm run validate:setup
 */
describe('Setup & schema validation', () => {
  let env: TestEnvironment;
  beforeEach(() => {
    env = TestEnvironment.create();
  });

  it('starts every test with an empty database except the one seeded customer', () => {
    expect(env.repos.customers.findById('cust_001')).toEqual({
      id: 'cust_001',
      email: 'cust_001@example.test',
      paymentMethodIds: ['pm_test_visa_4242'],
    });
    expect({
      subscriptions: env.repos.subscriptions.count(),
      invoices: env.repos.invoices.count(),
      paymentAttempts: env.repos.paymentAttempts.count(),
      webhookEvents: env.repos.webhookEvents.count(),
      auditLog: env.db.auditLog.length,
      notifications: env.db.notifications.length,
    }).toEqual({ subscriptions: 0, invoices: 0, paymentAttempts: 0, webhookEvents: 0, auditLog: 0, notifications: 0 });
  });

  it('exposes every persisted table the docs list', () => {
    expect(Object.keys(env.db).sort()).toEqual(
      ['auditLog', 'counters', 'customers', 'invoices', 'notifications', 'paymentAttempts', 'subscriptions', 'webhookEvents'].sort(),
    );
  });

  it('two environments never share data', async () => {
    const other = TestEnvironment.create();
    await env.given.trialingPro();
    expect(env.repos.subscriptions.count()).toBe(1);
    expect(other.repos.subscriptions.count()).toBe(0);
  });

  it('seeds the two plans with the documented price and trial rules', () => {
    const plans = new PlanCatalog();
    expect(plans.get('basic')).toMatchObject({ priceCents: 1900, trialDays: 0 });
    expect(plans.get('pro')).toMatchObject({ priceCents: 4900, trialDays: 14 });
  });

  it('uses a test-only webhook secret and a mock provider that has not been called', () => {
    expect(TEST_WEBHOOK_SECRET).toBe('whsec_test_only');
    expect(env.provider.callCount).toBe(0);
  });
});
