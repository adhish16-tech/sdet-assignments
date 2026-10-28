/**
 * PATTERN: Builder for the POST /subscriptions body.
 *
 * Defaults are a VALID request, so each test only states what it changes:
 *   aSubscriptionRequest().forPlan('basic').build()
 *   aSubscriptionRequest().without('customer_id').build()
 */
export type SubscriptionRequestBody = Record<string, unknown>;

export class SubscriptionRequestBuilder {
  private body: SubscriptionRequestBody = {
    customer_id: 'cust_001',
    plan: 'pro',
    payment_method_id: 'pm_test_visa_4242',
  };

  static aSubscriptionRequest(): SubscriptionRequestBuilder {
    return new SubscriptionRequestBuilder();
  }

  forCustomer(customerId: string): this {
    this.body.customer_id = customerId;
    return this;
  }

  forPlan(plan: string): this {
    this.body.plan = plan;
    return this;
  }

  withPaymentMethod(paymentMethodId: string): this {
    this.body.payment_method_id = paymentMethodId;
    return this;
  }

  without(field: 'customer_id' | 'plan' | 'payment_method_id'): this {
    delete this.body[field];
    return this;
  }

  build(): SubscriptionRequestBody {
    return { ...this.body };
  }
}
