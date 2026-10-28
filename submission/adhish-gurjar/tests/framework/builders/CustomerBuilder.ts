import { Customer } from '../../../src/persistence/entities';

/** PATTERN: Builder — a customer that reads as intent: aCustomer().withId('cust_x').build() */
export class CustomerBuilder {
  private customer: Customer = {
    id: 'cust_001',
    email: 'cust_001@example.test',
    paymentMethodIds: ['pm_test_visa_4242'],
  };

  static aCustomer(): CustomerBuilder {
    return new CustomerBuilder();
  }

  withId(id: string): this {
    this.customer.id = id;
    this.customer.email = `${id}@example.test`;
    return this;
  }

  withPaymentMethods(...ids: string[]): this {
    this.customer.paymentMethodIds = ids;
    return this;
  }

  build(): Customer {
    return structuredClone(this.customer);
  }
}
