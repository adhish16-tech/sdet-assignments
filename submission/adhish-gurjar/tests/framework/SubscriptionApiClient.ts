import { Express } from 'express';
import request from 'supertest';
import { SubscriptionDto } from '../../src/api/app';
import { WebhookOutcome } from '../../src/persistence/entities';
import { WebhookDelivery } from './builders/WebhookEventBuilder';

export interface ApiResponse<T> {
  status: number;
  body: T;
}
export interface ApiError {
  error: string;
  message: string;
  details?: string[];
}
export interface WebhookResponse {
  outcome: WebhookOutcome;
  duplicate: boolean;
}

/**
 * Typed HTTP client. Tests say `api.cancel(id)`, never build URLs or headers.
 * If a route or header changes, only this class changes.
 */
export class SubscriptionApiClient {
  constructor(private readonly app: Express) {}

  async create(body: Record<string, unknown>): Promise<ApiResponse<SubscriptionDto & ApiError>> {
    return this.send(request(this.app).post('/subscriptions').send(body));
  }

  async createRaw(rawJson: string): Promise<ApiResponse<ApiError>> {
    return this.send(request(this.app).post('/subscriptions').set('Content-Type', 'application/json').send(rawJson));
  }

  async get(id: string): Promise<ApiResponse<SubscriptionDto & ApiError>> {
    return this.send(request(this.app).get(`/subscriptions/${id}`));
  }

  async cancel(id: string): Promise<ApiResponse<SubscriptionDto & ApiError>> {
    return this.send(request(this.app).post(`/subscriptions/${id}/cancel`));
  }

  async runBilling(): Promise<ApiResponse<{ billed: string[] }>> {
    return this.send(request(this.app).post('/internal/billing/run'));
  }

  async postWebhook(delivery: WebhookDelivery): Promise<ApiResponse<WebhookResponse & ApiError>> {
    let req = request(this.app).post('/webhooks/payment-provider').set('Content-Type', 'application/json');
    if (delivery.signature !== undefined) req = req.set('X-Provider-Signature', delivery.signature);
    return this.send(req.send(delivery.rawBody));
  }

  private async send<T>(req: request.Test): Promise<ApiResponse<T>> {
    const res = await req;
    return { status: res.status, body: res.body as T };
  }
}
