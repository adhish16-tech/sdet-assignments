/**
 * PATTERN: State machine as an explicit transition table.
 *
 * Problem it solves: subscription status is the most dangerous field in the
 * system. If any code path can write `status = 'active'`, a stray webhook can
 * reactivate a canceled customer and bill them. Here, the ONLY way to get a
 * new status is to ask this table. Anything not listed is illegal by design.
 */

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

/** What happened — the input to the state machine. */
export type Trigger =
  | 'CHARGE_SUCCEEDED' // a charge for this subscription was confirmed paid
  | 'CHARGE_FAILED' // a charge was declined / reported failed
  | 'RETRIES_EXHAUSTED' // the last allowed retry failed
  | 'CANCEL'; // customer / API cancel

export const ALL_STATUSES: SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'canceled'];
export const ALL_TRIGGERS: Trigger[] = ['CHARGE_SUCCEEDED', 'CHARGE_FAILED', 'RETRIES_EXHAUSTED', 'CANCEL'];

/**
 * The lifecycle from the assignment, written as data.
 * Two self-loops are added deliberately and documented in docs/TEST_STRATEGY.md:
 *   active   + CHARGE_SUCCEEDED -> active    (a normal monthly renewal)
 *   past_due + CHARGE_FAILED    -> past_due  (a retry failed, but retries remain)
 * They do not change state; they let renewals and retries flow through the same table.
 */
const TRANSITIONS: Readonly<Record<SubscriptionStatus, Partial<Record<Trigger, SubscriptionStatus>>>> = {
  trialing: { CHARGE_SUCCEEDED: 'active', CHARGE_FAILED: 'past_due', CANCEL: 'canceled' },
  active: { CHARGE_SUCCEEDED: 'active', CHARGE_FAILED: 'past_due', CANCEL: 'canceled' },
  past_due: { CHARGE_SUCCEEDED: 'active', CHARGE_FAILED: 'past_due', RETRIES_EXHAUSTED: 'canceled' },
  canceled: {}, // terminal: nothing can ever move a canceled subscription
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: SubscriptionStatus,
    readonly trigger: Trigger,
  ) {
    super(`Invalid transition: ${trigger} is not allowed from '${from}'`);
    this.name = 'InvalidTransitionError';
  }
}

export class SubscriptionStateMachine {
  /** Returns the next status, or throws if the transition is not in the table. */
  next(from: SubscriptionStatus, trigger: Trigger): SubscriptionStatus {
    const to = TRANSITIONS[from][trigger];
    if (!to) throw new InvalidTransitionError(from, trigger);
    return to;
  }

  canApply(from: SubscriptionStatus, trigger: Trigger): boolean {
    return TRANSITIONS[from][trigger] !== undefined;
  }

  /** Exposed so tests can enumerate every legal edge and prove coverage. */
  allowedTransitions(): Array<{ from: SubscriptionStatus; trigger: Trigger; to: SubscriptionStatus }> {
    return ALL_STATUSES.flatMap((from) =>
      ALL_TRIGGERS.filter((t) => TRANSITIONS[from][t]).map((trigger) => ({
        from,
        trigger,
        to: TRANSITIONS[from][trigger]!,
      })),
    );
  }
}
