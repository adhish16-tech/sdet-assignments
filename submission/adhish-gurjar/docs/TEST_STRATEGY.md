# Test Strategy — Subscription & Billing Service

This document was written before the bulk of the automation and kept in sync with it.
It answers: what are we testing, at which level, against what, and what can still go wrong.

---

## 1. System under test (approach: Option 3 — Hybrid)

No service was provided, so this repo contains a **minimal service fixture** (`src/`) plus
**test doubles** for everything outside its boundary (`tests/framework/`).

| Component | Real or double? | Why |
|---|---|---|
| HTTP routes (Express) | **Real** | We test the actual request/response contract via Supertest, in-process. |
| `SubscriptionService` business logic | **Real** | This is the thing under test. |
| State machine (transition table) | **Real** | The core rule set; must not be faked. |
| Plan policies (Basic / Pro) | **Real** | Price/trial rules are part of the behaviour under test. |
| Webhook signature check + idempotency | **Real** | Security and duplicate handling are what we must prove. |
| Database + repositories | **Real (in-memory)** | Embedded Maps behind repositories. Queryable, zero setup, fresh per test. |
| Payment provider | **Mock** (`MockPaymentProvider`) | External, paid, non-deterministic. Injected through the `PaymentProvider` interface. |
| Inbound webhooks | **Simulated** (`WebhookSimulator`) | Test code plays the provider: builds signed / unsigned / tampered payloads. |
| Time | **Fake** (`FakeClock`) | Lets a test jump 14 days to the end of a trial. |
| Scheduled billing job | **Real code, triggered by test** via `POST /internal/billing/run` | In production this is a cron. |

## 2. Domain assumptions

- **Plans:** `basic` = 1900 cents / month, **no trial**, charged at sign-up.
  `pro` = 4900 cents / month, **14-day trial**, first charge when the trial ends. Billing period = 30 days.
- **Sign-up with an upfront charge (Basic):** the service charges first and persists **only on success**.
  Decline → `402`, timeout → `503`; in both cases no subscription, invoice or attempt row is written.
- **Lifecycle:** exactly the table from the brief, plus two *documented self-loops* that don't change state:
  - `active + CHARGE_SUCCEEDED → active` (monthly renewal)
  - `past_due + CHARGE_FAILED → past_due` (a retry failed but retries remain)
- **Retries:** max **3 declined attempts per invoice** (`MAX_PAYMENT_ATTEMPTS`). The billing job retries a
  `past_due` invoice on each run (no back-off schedule — out of scope).
- **Provider timeout = unknown outcome.** State is not changed, the invoice stays `open`, and the attempt
  number is *not* consumed — so the retry reuses the **same idempotency key** and the provider cannot
  double-charge. The real result may arrive later by webhook.
- **`payment.failed` webhook** for an open invoice counts as one declined attempt (same rules as a decline
  returned synchronously).
- **`payment.refunded`** marks a paid invoice `refunded`. It does **not** change lifecycle state (the brief
  defines no transition for it).
- **Authenticated, well-formed webhooks always get `200`** with an `outcome` field, even when ignored —
  so the provider stops redelivering. Only bad signatures (`401`) and malformed bodies (`400`) are errors.
- **Cancel** voids any open invoice, so the billing job can never charge it later.

### Questions I would raise with product (instead of guessing silently)
1. **`past_due → canceled` by the customer** is not in the brief's diagram, so the API rejects it with `409`.
   Most real products allow this. The test documents current behaviour; if product disagrees, it's a
   one-line change to the transition table plus one test update.
2. Should a refund move the subscription anywhere (e.g. cancel)? Assumed no.
3. A `payment.succeeded` for an invoice of an already-canceled subscription is ignored. In production
   this money should trigger an alert / auto-refund — out of scope here.

## 3. Scope

**In scope:** create / get / cancel APIs, the full lifecycle, webhook authenticity + shape + idempotency +
ordering, provider interaction (success / decline / timeout), persistence of subscriptions, invoices,
payment attempts, webhook events, audit log and notifications.

**Out of scope (non-goals):** plan changes / proration, taxes, multi-currency, retry back-off schedules,
real provider, real DB, performance, UI, report dashboards.

## 4. Test levels

| Level | Spec file | What it proves |
|---|---|---|
| Setup / schema validation | `00-setup-validation.spec.ts` | Every test starts from a known state: empty tables, one seeded customer, documented plans, no shared data between environments. |
| API contract & validation | `01-api-contract.spec.ts` | Status codes, payload shape, validation errors, webhook 401/400 handling. Rejected requests persist nothing and never charge. |
| State machine | `02-state-machine.spec.ts` | (a) The table itself: exactly 9 legal edges, the 7 others throw. (b) Every lifecycle edge driven through the real system, by API, billing run **and** webhook. (c) Invalid transitions impossible. (d) Plan rules. |
| Webhook idempotency & ordering | `03-webhook-idempotency.spec.ts` | Duplicates applied once, no duplicate rows / charges / notifications, out-of-order safety, refunds, parallel delivery (bonus). |
| Provider interaction (mock) | `04-payment-provider.spec.ts` | Exact arguments, call counts, idempotency keys, behaviour on success / decline / timeout, and when the provider must **not** be called. |
| Persistence & audit | `05-persistence-audit.spec.ts` | API == DB at every lifecycle checkpoint, audit trail content, webhook_events table, and **tests of the invariant checker itself**. |
| End-to-end journeys | `06-end-to-end.spec.ts` | Happy path, recovery path, dunning path — request/webhook in, DB + provider out. |

## 5. API contracts (as implemented by the fixture)

| Endpoint | Success | Errors |
|---|---|---|
| `POST /subscriptions` `{customer_id, plan, payment_method_id}` | `201` subscription DTO | `400 validation_error` (missing field / bad pm format), `400 unknown_plan`, `404 customer_not_found`, `400 invalid_payment_method` (not the customer's), `400 malformed_json`, `402 payment_declined`, `503 payment_provider_unavailable` |
| `GET /subscriptions/:id` | `200` DTO | `404 subscription_not_found` |
| `POST /subscriptions/:id/cancel` | `200` DTO (`status: canceled`) | `404`, `409 invalid_transition` |
| `POST /webhooks/payment-provider` + `X-Provider-Signature` (HMAC-SHA256 of raw body, hex) | `200 {outcome, duplicate}` | `401 missing_signature / invalid_signature`, `400 malformed_payload` |
| `POST /internal/billing/run` (test hook for the cron) | `200 {billed: [ids]}` | — |

Subscription DTO: `id, customer_id, plan, status, price_cents, currency, trial_ends_at, current_period_end, canceled_at, created_at`.

## 6. Database entities and invariants

| Entity | Checked for |
|---|---|
| `subscriptions` | status, plan, price, trial end, period end, canceledAt — compared field-by-field with the API. |
| `invoices` | one per billing period; status `open/paid/uncollectible/void/refunded`; `attemptCount`; `paidAt`. |
| `payment_attempts` | one row per provider call: outcome, idempotency key, provider charge id, decline code. |
| `webhook_events` | one row per unique `event_id`, with `outcome` and `deliveryCount` (proves duplicates were seen and no-op'd). |
| `audit_log` | append-only: action, from/to status, source (`api` / `billing_run` / `webhook`), reference (invoice or event id). |
| `notifications` | the customer-facing side effect; proves nothing fires twice. |

**Invariants** — checked automatically by `SubscriptionVerifier.expectAllInvariantsHold()` in an
`afterEach` of every spec, so *every* test also proves the whole database is still coherent:

1. A subscription is never `active` without a paid (or later refunded) invoice.
2. A `canceled` subscription has `canceledAt` and no open invoice; nothing else has `canceledAt`.
3. Subscription price and every invoice amount equal the plan price (creation and billing agree).
4. `paidAt` is set if and only if an invoice is paid/refunded; no invoice predates its subscription.
5. At most one successful charge per invoice (no double charge).
6. At most one open invoice per subscription.
7. The audit trail ends in the subscription's current status.
8. `updatedAt >= createdAt`.
9. Notifications fired == real state changes recorded in the audit log (no duplicate side effects).
10. An idempotency key is only reused after a `timeout` (a retry of an unknown outcome), never after a definitive one.

### Seeding, cleanup and avoiding false positives
- **Fresh world per test.** `TestEnvironment.create()` in `beforeEach` builds a new database, mock and clock,
  and seeds one default customer. There is nothing to clean up and nothing stale to read.
- **Starting states are reached through the real system** (`env.given.pastDuePro()` = create → advance
  clock → decline → billing run), never by writing a status into the DB. So a test can't start from a
  state the real system could never reach.
- **Repositories return deep copies**, so a test can't accidentally mutate stored data and pass.
- **`provider.resetCalls()` after setup**, so call-count assertions only count what the test itself did.
- **The invariant checker is itself tested**: `05-persistence-audit.spec.ts` corrupts data on purpose and
  asserts the checker reports it. A checker that always returns "no violations" would fail those tests.
- **Bug-injection check (manual):** I broke the service in 8 ways and confirmed the suite goes red each time
  (results in the PR description).

## 7. Webhook / idempotency strategy

Three gates, in order: **signature** (HMAC over the raw bytes, constant-time compare) → **shape** (JSON +
required fields + known type + integer amount) → **idempotency** (`event_id` lookup in `webhook_events`).

- First delivery: the event is applied and stored with its outcome.
- Redelivery: `deliveryCount` is incremented, the *stored* outcome is returned with `duplicate: true`,
  nothing else runs.
- Business-level safety in addition to `event_id` dedupe (a provider can send *different* event ids for the
  same money): an event is only applied to an **open** invoice, amounts must match the invoice, and a
  canceled subscription ignores everything.

## 8. Reliability classes covered

| Risk | Where tested |
|---|---|
| Duplicate / redelivered webhooks | `03` (same id ×2, ×5, failed ×3, ignored-then-redelivered) |
| Out-of-order delivery | `02` + `03` (failed after succeeded; succeeded after failed) |
| Provider timeouts and declines | `04` (sign-up and billing run), `06` recovery journey |
| Forged / unsigned / tampered webhooks | `01` (401 cases, nothing recorded) |
| Invalid state transitions | `02` (table-level and system-level) |
| Subscription / invoice mismatch | invariants after every test + `05` checkpoints |
| Concurrent delivery (bonus) | `03` (5 parallel deliveries) — see limitation below |

## 9. Known limitations
- **Concurrency test is weak evidence.** The in-memory fixture processes each request synchronously, so the
  parallel-delivery test proves the check-then-insert logic, not DB-level locking. Against a real database
  this needs a unique constraint on `event_id` (or `INSERT ... ON CONFLICT DO NOTHING`) and a real race test.
- **In-process HTTP.** Supertest calls the Express app directly; no network, TLS or proxy behaviour is tested.
- **Fixture, not production code.** The service was built only to be tested; a real service would differ.
  The framework is designed so swapping in a real service mostly means changing `TestEnvironment`.
- No retry back-off timing, proration, tax or currency conversion.
