# Interview guide — how to explain this in 5 minutes

You don't need to memorise code. You need to explain **why** each piece exists. Everything below maps to
something you already do on FleetPlus (payments, state, duplicates, reconciliation).

## The 30-second pitch
"I treated this as a stateful money workflow. The risks are: wrong status, double charging, and trusting
the outside world. So I built (1) a state machine so status can't be changed ad hoc, (2) a mock payment
provider so I control success, decline and timeout, and (3) a verifier that checks 10 business rules on the
database after every single test. The tests don't just check status codes, they check that the API, the
database and the provider calls all agree."

## The picture
```
 Spec (readable scenario)
   └─ TestEnvironment  (fresh DB + mock + clock per test)
        ├─ ApiClient ──HTTP──► Express app ► SubscriptionService ► Repositories ► in-memory DB
        ├─ WebhookSimulator  (acts as the payment provider sending signed webhooks)
        ├─ MockPaymentProvider (injected; success / decline / timeout; records calls)
        └─ Verifier (reads DB via repositories; checks invariants)
```

## Likely questions and your answers

**Why build a service at all?** None was provided; the brief allowed a minimal fixture. I kept it small and
put the effort into the test design.

**What's real and what's mocked?** Real: routes, logic, state machine, DB. Mocked: only the payment provider,
time, and the webhook sender. I mock what is external or non-deterministic, nothing else.

**Why a transition table?** If any code can write `status = 'active'`, one stray webhook reactivates a
canceled customer. Here only `transition()` changes status and it asks the table. Illegal pairs throw. I test the
table directly (9 legal, 7 illegal) and through the system.

**How do you prove idempotency?** Same `event_id` delivered 2 and 5 times: one state change, one invoice, one
notification, zero extra provider calls, and `deliveryCount` goes up so I can see the duplicates were received and
ignored. I also cover a *different* event id for an already-paid invoice, which the provider can really do.

**What about out-of-order events?** `payment.failed` after `payment.succeeded` for the same invoice is ignored
because the invoice is no longer open. Active doesn't regress.

**What does a timeout mean?** The outcome is unknown, so I don't change state. The retry reuses the same
idempotency key so the provider can't charge twice. A later webhook can settle it.

**How do you avoid false positives?** Fresh DB per test, repositories return copies, starting states are reached
through the real API (not by editing rows), call history is reset after setup, and the invariant checker has its
own tests where I corrupt data and confirm it complains.

**How do you know the tests catch bugs?** I broke the service 8 ways (remove the dedupe, allow
canceled→active, skip the signature check, etc.) and every one made tests fail. That's mutation checking, done manually.

**Which patterns and why?** State machine, Builder, DI seam, Repository, Strategy (plans), Facade
(TestEnvironment). Only ones that are really in the code.

**What are the weaknesses?** (Say these yourself; it builds trust.)
- The concurrency test is weak: in-memory and synchronous. Real fix = unique constraint on `event_id` in the DB plus a real race test.
- `past_due → canceled` by the customer isn't in the brief, so I reject it and flagged it as a product question.
- It tests a fixture I wrote, not their production service.

**What would you do next?** Run against a real DB (Postgres via Testcontainers), add contract tests against the
provider's sandbox, add plan-change/proration, CI pipeline, and a real concurrency test.

## Responsible AI paragraph — be honest
They explicitly ask. A safe, true version (edit to match what you really do before submitting):

"I used Claude to scaffold the fixture and specs and draft docs. I defined the scope with it, read through the
code, ran the suite, injected bugs to confirm the tests fail when they should, and I'm able to explain every
design decision. I also flagged an assumption (past_due cancel) rather than silently choosing."

**Do this before the interview (30 minutes, makes it truly yours):**
1. Run `npm test` and read one spec file top to bottom (start with `02-state-machine.spec.ts`).
2. Open `SubscriptionService.transition()` and `WebhookHandler.handle()`. These two functions are the heart.
3. Break something yourself (e.g. delete the `if (seen)` check) and watch which tests fail.
4. Say the 30-second pitch out loud twice.

## Connect it to your experience
Payments/POS and FleetPlus rewards validation = money state + reconciliation. Duplicate transactions and
settlement mismatches are the same class of bug as duplicate webhooks. Say that.
