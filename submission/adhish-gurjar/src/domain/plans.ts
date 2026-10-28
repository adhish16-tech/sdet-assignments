/**
 * PATTERN: Strategy (one policy object per plan) + a small catalog (registry).
 *
 * Problem it solves: price, trial length and "charge now or start a trial?"
 * differ per plan. Without this, `if (plan === 'pro') ... else ...` ends up
 * copied into creation, billing and tests. With it, the service asks the plan
 * policy, and a new plan is one new class plus one catalog entry.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlanPolicy {
  readonly code: string;
  readonly priceCents: number;
  readonly currency: 'USD';
  readonly trialDays: number;
  readonly billingPeriodDays: number;
  /** true = charge at sign-up, false = start a free trial */
  requiresUpfrontCharge(): boolean;
  /** When the first charge is due, given the sign-up time. */
  firstChargeAt(createdAt: Date): Date;
  /** When the next period ends after a successful charge at `paidAt`. */
  nextPeriodEnd(paidAt: Date): Date;
}

abstract class BasePlan implements PlanPolicy {
  abstract readonly code: string;
  abstract readonly priceCents: number;
  abstract readonly trialDays: number;
  readonly currency = 'USD' as const;
  readonly billingPeriodDays = 30;

  requiresUpfrontCharge(): boolean {
    return this.trialDays === 0;
  }
  firstChargeAt(createdAt: Date): Date {
    return new Date(createdAt.getTime() + this.trialDays * DAY_MS);
  }
  nextPeriodEnd(paidAt: Date): Date {
    return new Date(paidAt.getTime() + this.billingPeriodDays * DAY_MS);
  }
}

/** Basic: $19/month, no trial, charged immediately at sign-up. */
export class BasicPlan extends BasePlan {
  readonly code = 'basic';
  readonly priceCents = 1900;
  readonly trialDays = 0;
}

/** Pro: $49/month, 14-day free trial, first charge when the trial ends. */
export class ProPlan extends BasePlan {
  readonly code = 'pro';
  readonly priceCents = 4900;
  readonly trialDays = 14;
}

export class PlanCatalog {
  private readonly plans = new Map<string, PlanPolicy>();

  constructor(plans: PlanPolicy[] = [new BasicPlan(), new ProPlan()]) {
    plans.forEach((p) => this.plans.set(p.code, p));
  }

  find(code: string): PlanPolicy | undefined {
    return this.plans.get(code);
  }

  get(code: string): PlanPolicy {
    const plan = this.find(code);
    if (!plan) throw new Error(`Unknown plan '${code}'`);
    return plan;
  }
}
