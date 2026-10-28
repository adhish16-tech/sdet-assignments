import { InvoiceRow } from '../../src/persistence/entities';
import { WebhookDelivery, WebhookEventBuilder } from './builders/WebhookEventBuilder';
import { SubscriptionApiClient } from './SubscriptionApiClient';

/**
 * Plays the role of the payment provider sending webhooks to us.
 * Knows the shared secret, builds events, and delivers them once, twice, or in parallel.
 */
export class WebhookSimulator {
  constructor(
    readonly secret: string,
    private readonly api: SubscriptionApiClient,
  ) {}

  /** Start building an event. */
  event(): WebhookEventBuilder {
    return WebhookEventBuilder.aWebhook(this.secret);
  }

  succeeded(invoice: InvoiceRow): WebhookEventBuilder {
    return this.event().paymentSucceeded().forInvoice(invoice);
  }
  failed(invoice: InvoiceRow): WebhookEventBuilder {
    return this.event().paymentFailed().forInvoice(invoice);
  }
  refunded(invoice: InvoiceRow): WebhookEventBuilder {
    return this.event().paymentRefunded().forInvoice(invoice);
  }

  deliver(builderOrDelivery: WebhookEventBuilder | WebhookDelivery) {
    return this.api.postWebhook(this.toDelivery(builderOrDelivery));
  }

  /** Same bytes, same event_id, sent `times` times one after another (provider redelivery). */
  async deliverRepeatedly(builder: WebhookEventBuilder, times: number) {
    const delivery = builder.build();
    const responses = [];
    for (let i = 0; i < times; i++) responses.push(await this.api.postWebhook(delivery));
    return responses;
  }

  /** Same event fired in parallel (racing redelivery). */
  deliverConcurrently(builder: WebhookEventBuilder, times: number) {
    const delivery = builder.build();
    return Promise.all(Array.from({ length: times }, () => this.api.postWebhook(delivery)));
  }

  private toDelivery(x: WebhookEventBuilder | WebhookDelivery): WebhookDelivery {
    return x instanceof WebhookEventBuilder ? x.build() : x;
  }
}
