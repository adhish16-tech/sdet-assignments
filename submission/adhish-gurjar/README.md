# Subscription & Billing — Automated Test Suite

An object-oriented TypeScript test framework (Jest + Supertest) that validates a Subscription & Billing
service at four levels: API, state machine, database, and mocked payment-provider integration.

Because no service was provided, the repo includes a small **service fixture** (`src/`) to test against.
Full strategy, assumptions and limitations: [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md).

## Run it

```bash
npm install
npm test               # 93 tests, ~3 seconds
npm run lint           # ESLint
npm run build          # tsc --noEmit (type check)
npm run validate:setup # setup / schema validation spec only
npm run validate       # lint + build + all tests
npm run test:coverage  # optional
```

Requires Node 18+. No database, network or environment variables are needed: persistence is embedded and
in-memory, and a fresh instance is created for every test (so there is no seed or cleanup step).

## Layout

```
src/                               SYSTEM UNDER TEST (the fixture)
  domain/SubscriptionStateMachine.ts   transition table: the only way status changes
  domain/plans.ts                      Basic / Pro plan policies + catalog
  payment/PaymentProvider.ts           interface the service depends on (the seam)
  persistence/                         entities, in-memory Database, repositories
  service/SubscriptionService.ts       business logic (create, cancel, billing run, webhook events)
  service/WebhookHandler.ts            signature check → validation → idempotency
  api/app.ts                           Express routes + composition root

tests/
  framework/                       THE TEST FRAMEWORK
    TestEnvironment.ts                 builds an isolated world per test + "given" scenarios
    SubscriptionApiClient.ts           typed HTTP client
    MockPaymentProvider.ts             scripted success/decline/timeout, records calls
    WebhookSimulator.ts                plays the provider: single, repeated, parallel delivery
    SubscriptionVerifier.ts            repository-based assertions + invariant checker
    FakeClock.ts                       controllable time
    builders/                          CustomerBuilder, SubscriptionRequestBuilder, WebhookEventBuilder
  specs/                           THE SCENARIOS (readable, no plumbing)
    00-setup-validation  01-api-contract  02-state-machine  03-webhook-idempotency
    04-payment-provider  05-persistence-audit  06-end-to-end
```

## Design patterns used (and the problem each solves)

| Pattern | Where | Problem it actually solved |
|---|---|---|
| **State machine (transition table)** | `SubscriptionStateMachine.ts` | Status can't be set ad hoc. One `transition()` method in the service is the only writer, and it asks the table. Illegal moves throw. |
| **Builder** | `tests/framework/builders/` | Scenarios read as intent: `aWebhook(secret).paymentFailed().forInvoice(inv).signedWithWrongSecret()` instead of repeated object literals. |
| **Dependency injection / interface seam** | `PaymentProvider` | The service never imports a real provider; tests inject `MockPaymentProvider`. |
| **Repository** | `persistence/repositories.ts` | Tests ask named questions (`invoices.findBySubscription`) instead of reading raw maps; reads return copies. |
| **Strategy** | `domain/plans.ts` | Price, trial length and charge-now-or-trial live in one plan object each, not in `if (plan === ...)` branches. |
| **Facade** | `TestEnvironment` | One call builds the whole wired world for a test. |

## Conventions
- Specs never touch HTTP details, signatures or storage directly — only the framework classes.
- Every spec runs `verify.expectAllInvariantsHold()` after each test, so each test also proves the whole
  database is still coherent.
- Starting states come from `env.given.*` (reached through the real API/billing run), never by editing rows.
