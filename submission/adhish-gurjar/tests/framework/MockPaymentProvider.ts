import { ChargeRequest, ChargeResult, PaymentProvider, ProviderTimeoutError } from '../../src/payment/PaymentProvider';

type Outcome = 'success' | 'decline' | 'timeout';

/**
 * Test double for the external payment provider.
 *
 * - Implements the SAME interface the service depends on (it is injected, not patched).
 * - Outcomes are scripted per call: `willDecline()` affects the next charge only.
 *   With nothing scripted, a charge succeeds.
 * - `charge` is a jest.fn, so every call and its arguments are recorded.
 */
export class MockPaymentProvider implements PaymentProvider {
  private readonly script: Outcome[] = [];
  private chargeSeq = 0;

  readonly charge = jest.fn(async (request: ChargeRequest): Promise<ChargeResult> => {
    const outcome = this.script.shift() ?? 'success';
    if (outcome === 'timeout') throw new ProviderTimeoutError();
    if (outcome === 'decline') return { status: 'declined', declineCode: 'card_declined' };
    this.chargeSeq += 1;
    return { status: 'succeeded', providerChargeId: `ch_mock_${this.chargeSeq}_${request.invoiceId}` };
  });

  willSucceed(times = 1): this {
    return this.enqueue('success', times);
  }
  willDecline(times = 1): this {
    return this.enqueue('decline', times);
  }
  willTimeout(times = 1): this {
    return this.enqueue('timeout', times);
  }

  /** Arguments of every charge, in order. */
  get requests(): ChargeRequest[] {
    return this.charge.mock.calls.map(([req]) => req);
  }
  get callCount(): number {
    return this.charge.mock.calls.length;
  }
  lastRequest(): ChargeRequest {
    const all = this.requests;
    if (!all.length) throw new Error('Payment provider was never called');
    return all[all.length - 1];
  }

  /** Forget recorded calls (e.g. after scenario setup) so the test asserts only on what it did. */
  resetCalls(): void {
    this.charge.mockClear();
  }

  private enqueue(o: Outcome, times: number): this {
    for (let i = 0; i < times; i++) this.script.push(o);
    return this;
  }
}
