import express, { NextFunction, Request, Response } from 'express';
import { PlanCatalog } from '../domain/plans';
import { Database } from '../persistence/Database';
import { Repositories } from '../persistence/repositories';
import { PaymentProvider } from '../payment/PaymentProvider';
import { Clock, SystemClock } from '../service/Clock';
import { ServiceError } from '../service/errors';
import { SubscriptionService } from '../service/SubscriptionService';
import { WebhookHandler } from '../service/WebhookHandler';

export interface AppDependencies {
  db?: Database;
  paymentProvider: PaymentProvider; // required: there is no default, real or fake
  clock?: Clock;
  plans?: PlanCatalog;
  webhookSecret: string;
}

/** Composition root: wires real service code to whatever dependencies are injected. */
export function createApp(deps: AppDependencies) {
  const db = deps.db ?? new Database();
  const clock = deps.clock ?? new SystemClock();
  const repos = new Repositories(db);
  const service = new SubscriptionService(repos, deps.paymentProvider, deps.plans ?? new PlanCatalog(), clock);
  const webhooks = new WebhookHandler(deps.webhookSecret, repos, service, clock);

  const app = express();

  // The webhook needs the RAW body: the signature is computed over exact bytes.
  app.post('/webhooks/payment-provider', express.text({ type: '*/*' }), (req, res, next) => {
    try {
      const raw = typeof req.body === 'string' ? req.body : '';
      res.status(200).json(webhooks.handle(raw, req.header('X-Provider-Signature')));
    } catch (err) {
      next(err);
    }
  });

  app.use(express.json());

  app.post('/subscriptions', async (req, res, next) => {
    try {
      res.status(201).json(toDto(await service.create(req.body ?? {})));
    } catch (err) {
      next(err);
    }
  });

  app.get('/subscriptions/:id', (req, res, next) => {
    try {
      res.json(toDto(service.get(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  app.post('/subscriptions/:id/cancel', (req, res, next) => {
    try {
      res.json(toDto(service.cancel(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  /** Stands in for the scheduled billing cron so tests can trigger it. */
  app.post('/internal/billing/run', async (_req, res, next) => {
    try {
      res.json({ billed: await service.runBillingCycle() });
    } catch (err) {
      next(err);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceError) {
      return res.status(err.httpStatus).json({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof SyntaxError) {
      return res.status(400).json({ error: 'malformed_json', message: 'Request body is not valid JSON' });
    }
    return res.status(500).json({ error: 'internal_error', message: String(err) });
  });

  return { app, service, repos, db };
}

/** Public API shape (snake_case), separate from the stored row shape. */
function toDto(s: ReturnType<SubscriptionService['get']>) {
  return {
    id: s.id,
    customer_id: s.customerId,
    plan: s.plan,
    status: s.status,
    price_cents: s.priceCents,
    currency: s.currency,
    trial_ends_at: s.trialEndsAt,
    current_period_end: s.currentPeriodEnd,
    canceled_at: s.canceledAt,
    created_at: s.createdAt,
  };
}

export type SubscriptionDto = ReturnType<typeof toDto>;
