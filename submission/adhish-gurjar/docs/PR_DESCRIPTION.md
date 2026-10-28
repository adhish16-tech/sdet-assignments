## Summary
Object-oriented Jest/TypeScript test framework plus a small service fixture for the Subscription & Billing Service
(approach: **Option 3, hybrid** — no service was provided, so I built a minimal one and mocked the payment provider).
93 tests in 7 spec files cover the API, the lifecycle state machine, persistence, webhook idempotency and the mocked provider.

Location: `submission/adhish-gurjar/`. Run: `npm install && npm run validate`. Full strategy: `docs/TEST_STRATEGY.md`.

## Test Strategy
- **Levels:** setup/schema, API contract, state machine (table + system level), database/audit, provider interaction, end-to-end journeys.
- **In scope:** create / get / cancel, the full lifecycle, webhook signature, shape, idempotency and ordering, provider success / decline / timeout, persisted entities.
- **Out of scope:** plan changes and proration, tax, multi-currency, retry back-off timing, a real provider, performance. (Plan *price and trial* rules are covered.)
- **Real:** routes, service logic, state machine, plan rules, signature check, idempotency, repositories, in-memory DB.
- **Mocked / simulated:** payment provider (`MockPaymentProvider`), inbound webhooks (`WebhookSimulator`), time (`FakeClock`).
- **Order of work:** I wrote `docs/TEST_STRATEGY.md` (assumptions, scope, contracts, entities, invariants) first, then the fixture and specs in small steps, then refactored.

## OOP & Design Pattern Choices
| Pattern | Where | Problem it solved here |
|---|---|---|
| State machine (transition table) | `src/domain/SubscriptionStateMachine.ts` | Status cannot be set ad hoc. The service has one `transition()` method that asks the table; illegal moves throw. |
| Builder | `tests/framework/builders/*` | Scenarios read as intent. The webhook builder also makes forged variants (unsigned, wrong secret, tampered body) in one line. |
| Dependency injection seam | `src/payment/PaymentProvider.ts` | The service never imports a real provider; tests inject the mock. |
| Repository | `src/persistence/repositories.ts` | Tests read persisted state through named queries that return copies, not raw maps. |
| Strategy | `src/domain/plans.ts` | Price, trial length and "charge now or trial" live in one object per plan instead of `if (plan === ...)` branches. |
| Facade | `tests/framework/TestEnvironment.ts` | One call builds an isolated, fully wired world per test. |

I only list patterns that exist in the code and solve a real problem there.

## API Validation Approach
A typed `SubscriptionApiClient` keeps URLs, headers and transport out of specs. Success responses are asserted with `toEqual` on the full DTO.
Every validation failure (missing field, unknown plan, unknown customer, foreign or malformed payment method, bad JSON, already-canceled) asserts the status code, the error code, **that nothing was persisted, and that the provider was not called**.
Webhook endpoint: valid signature, missing / wrong-secret / tampered signature (401), non-JSON / missing field / unknown type / bad amount (400).

## Database Validation Approach
Entities: subscriptions, invoices, payment attempts, webhook events, audit log, notifications. Reads go through repositories only.
`SubscriptionVerifier.expectAllInvariantsHold()` runs after the tests and checks 10 rules, including: never `active` without a paid invoice, a canceled subscription has no open invoice, price matches the plan at creation and billing, at most one successful charge per invoice, the audit trail ends in the current status, and notifications equal real state changes.
The API response is compared field by field with the stored row at each lifecycle checkpoint. The checker itself is tested by corrupting data on purpose.

## Mock Payment Provider & Webhook Validation
`MockPaymentProvider` implements the same interface the service uses, is scripted per call (`willDecline()`, `willTimeout()`) and is a `jest.fn`, so arguments are asserted exactly (customer, payment method, amount, currency, invoice, idempotency key).
Duplicates: the same `event_id` delivered 2 and 5 times gives one transition, one invoice, one notification, zero extra provider calls, and a rising `deliveryCount`. A *different* event id for an already-paid invoice is also a no-op.
Timeout is treated as an unknown outcome: no state change, and the retry reuses the idempotency key.
**Confidence check:** I injected 8 deliberate bugs into the fixture (removed duplicate check, canceled→active allowed, no canceled guard, no out-of-order guard, billing canceled subscriptions, signature check bypassed, retries never exhausted, random idempotency key). The suite failed each time and passed again once restored.

## State-Machine / Lifecycle Coverage
- The table test lists exactly the 9 legal edges (the 7 from the brief plus 2 documented self-loops: renewal and failed-retry) and proves the other 7 (status, trigger) pairs throw.
- Each brief transition runs through the real system, by API, billing run **and** webhook where applicable.
- Invalid transitions proven impossible: canceled → active (stray webhook), canceled → canceled (second cancel, 409), `payment.failed` after `payment.succeeded` (no regression), nothing reactivates a canceled subscription after retries are exhausted.

## Test Architecture
Layers: **specs** (readable scenarios) → **framework** (environment, API client, mock, simulator, verifier, builders, fake clock) → **fixture** (system under test).
A new scenario uses existing helpers; a route or header change touches one class. A fresh database, mock and clock per test removes stale-data false positives, and starting states are reached through the real API rather than edited rows.

## Validation
```
npm run lint            # ESLint, clean
npm run build           # tsc --noEmit, clean
npm test                # 93 tests, 7 suites, passing
npm run validate:setup  # setup / schema validation spec
npm run validate        # all of the above
```
README steps were run from a clean `npm install` in a fresh copy.

## Known Limitations / Next Steps
- The parallel-delivery test is weak evidence: the in-memory fixture is synchronous. Against a real DB it needs a unique constraint on `event_id` plus a real race test.
- The fixture is code I wrote to be tested, not their production service; swapping in a real service should mostly mean changing `TestEnvironment`.
- Open question for product: a customer cancelling from `past_due` is not in the brief, so the API rejects it with 409 (one line in the transition table to change).
- Next: Postgres via Testcontainers, provider sandbox contract tests, plan changes / proration, CI.

## Responsible AI Usage
I used Claude (an AI assistant) to help scaffold the fixture and specs and to draft the documentation. The scope, the assumptions and the open question about `past_due` cancellation were discussed and decided with it.
What I did myself: ran the suite, read the code and specs, and checked that the tests fail when the service is broken (the bug-injection list above). I can explain every design decision.
I did not use AI output without running it.

## Author Checklist
- [x] Linting passes
- [x] Type check passes (`npm run build`)
- [x] Test suite passes
- [x] Schema/setup validation passes
- [x] Every listed lifecycle transition is exercised by at least one test
- [x] At least two invalid transitions are proven impossible
- [x] Webhook idempotency (duplicate `event_id`) is tested
- [x] README was tested from a clean setup
