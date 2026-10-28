import { Express } from 'express';
import { createApp } from '../../src/api/app';
import { PlanCatalog } from '../../src/domain/plans';
import { Database } from '../../src/persistence/Database';
import { Repositories } from '../../src/persistence/repositories';
import { CustomerBuilder } from './builders/CustomerBuilder';
import { SubscriptionRequestBuilder } from './builders/SubscriptionRequestBuilder';
import { FakeClock } from './FakeClock';
import { MockPaymentProvider } from './MockPaymentProvider';
import { SubscriptionApiClient } from './SubscriptionApiClient';
import { SubscriptionVerifier } from './SubscriptionVerifier';
import { WebhookSimulator } from './WebhookSimulator';

export const TEST_WEBHOOK_SECRET = 'whsec_test_only';

/**
 * Test fixture: one fully wired, isolated world per test.
 *
 *   REAL    : HTTP routes, service logic, state machine, plan rules,
 *             signature check, idempotency, repositories, database.
 *   DOUBLES : MockPaymentProvider (external system), FakeClock (time),
 *             WebhookSimulator (plays the provider sending webhooks).
 *
 * A NEW database, mock and clock are built for every test (`beforeEach`),
 * so no row from a previous test can make this one pass by accident.
 */
export class TestEnvironment {
  readonly clock = new FakeClock();
  readonly provider = new MockPaymentProvider();
  readonly db = new Database();
  readonly plans = new PlanCatalog();
  readonly repos: Repositories;
  readonly app: Express;
  readonly api: SubscriptionApiClient;
  readonly webhooks: WebhookSimulator;
  readonly verify: SubscriptionVerifier;
  readonly given: Scenarios;

  private constructor() {
    const wired = createApp({
      db: this.db,
      paymentProvider: this.provider,
      clock: this.clock,
      plans: this.plans,
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    this.app = wired.app;
    this.repos = wired.repos;
    this.api = new SubscriptionApiClient(this.app);
    this.webhooks = new WebhookSimulator(TEST_WEBHOOK_SECRET, this.api);
    this.verify = new SubscriptionVerifier(this.repos, this.api, this.plans);
    this.given = new Scenarios(this);
  }

  /** Builds the world and seeds the default customer used by builders. */
  static create(): TestEnvironment {
    const env = new TestEnvironment();
    env.seedCustomer(CustomerBuilder.aCustomer());
    return env;
  }

  seedCustomer(builder: CustomerBuilder): void {
    this.repos.customers.save(builder.build());
  }
}

/**
 * "Given" steps that put a subscription into a starting state.
 *
 * They go through the PUBLIC API + billing run + mock provider — never by
 * writing a status into the database — so every starting state is one the
 * real system can actually reach. Recorded provider calls are cleared at the
 * end so a test asserts only on what IT caused.
 */
export class Scenarios {
  constructor(private readonly env: TestEnvironment) {}

  async trialingPro(): Promise<string> {
    const res = await this.env.api.create(SubscriptionRequestBuilder.aSubscriptionRequest().forPlan('pro').build());
    if (res.status !== 201) throw new Error(`Setup failed: ${JSON.stringify(res.body)}`);
    this.env.provider.resetCalls();
    return res.body.id;
  }

  async activeBasic(): Promise<string> {
    const res = await this.env.api.create(SubscriptionRequestBuilder.aSubscriptionRequest().forPlan('basic').build());
    if (res.status !== 201) throw new Error(`Setup failed: ${JSON.stringify(res.body)}`);
    this.env.provider.resetCalls();
    return res.body.id;
  }

  /** Pro, trial over, first charge succeeded. */
  async activePro(): Promise<string> {
    const id = await this.trialingPro();
    await this.trialEndsAndBillingRuns();
    this.env.provider.resetCalls();
    return id;
  }

  /** Pro, trial over, first charge declined (1 of 3 attempts used). */
  async pastDuePro(): Promise<string> {
    const id = await this.trialingPro();
    this.env.provider.willDecline();
    await this.trialEndsAndBillingRuns();
    this.env.provider.resetCalls();
    return id;
  }

  async canceledPro(): Promise<string> {
    const id = await this.trialingPro();
    await this.env.api.cancel(id);
    return id;
  }

  /** Moves time past the 14-day Pro trial and runs the billing job. */
  async trialEndsAndBillingRuns(): Promise<void> {
    this.env.clock.advanceDays(14);
    await this.env.api.runBilling();
  }
}
