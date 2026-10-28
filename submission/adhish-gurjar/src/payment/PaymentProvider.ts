/**
 * PATTERN: Dependency-injection seam (interface) around the external provider.
 *
 * Problem it solves: the real provider is a paid, remote, non-deterministic
 * system. The service only knows this interface, so tests inject a mock that
 * can be told to succeed, decline or time out, and that records every call.
 * No production code imports a concrete provider.
 */

export interface ChargeRequest {
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency: string;
  invoiceId: string;
  /** Sent to the provider so a retried network call never double-charges. */
  idempotencyKey: string;
}

export type ChargeResult =
  | { status: 'succeeded'; providerChargeId: string }
  | { status: 'declined'; declineCode: string };

/** Thrown when the provider does not answer in time. The outcome is UNKNOWN. */
export class ProviderTimeoutError extends Error {
  constructor(message = 'Payment provider timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}
