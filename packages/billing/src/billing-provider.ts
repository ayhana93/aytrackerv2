import type { CountryCode, Money } from '@aytracker/types';
import type { BillingInterval } from './pricing-catalog.js';

/**
 * The seam between AYtracker and whoever processes the money.
 *
 * Application  →  BillingService  →  BillingProvider  →  Stripe
 *
 * The application never imports Stripe. Swapping providers means writing one adapter that
 * satisfies this interface — nothing above it changes. That is the only reason this interface
 * exists, so it is kept deliberately small and free of Stripe-shaped concepts.
 */

export interface ProviderCustomer {
  readonly externalId: string;
}

export interface ProviderSubscription {
  readonly externalId: string;
  readonly status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'PAUSED' | 'CANCELLED' | 'EXPIRED';
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly trialEndsAt: Date | null;
  readonly cancelAt: Date | null;
}

export interface CreateCustomerInput {
  readonly organizationId: string;
  readonly legalName: string;
  readonly email: string;
  readonly countryCode: CountryCode;
  readonly vatNumber?: string | undefined;
  readonly addressLine1?: string | undefined;
  readonly city?: string | undefined;
  readonly region?: string | undefined;
  readonly postalCode?: string | undefined;
}

export interface CreateSubscriptionInput {
  readonly customerExternalId: string;
  /** Provider-side price identifier, taken from the price row we already resolved. */
  readonly externalPriceId: string;
  readonly quantity: number;
  readonly trialDays?: number | undefined;
  /** Idempotency key so a retried request cannot create two subscriptions. */
  readonly idempotencyKey: string;
}

export interface ChangeSubscriptionInput {
  readonly subscriptionExternalId: string;
  readonly externalPriceId: string;
  readonly quantity: number;
  /** Whether the change takes effect now with a proration, or at period end. */
  readonly effective: 'IMMEDIATE' | 'PERIOD_END';
  readonly idempotencyKey: string;
}

export interface InvoiceSummary {
  readonly externalId: string;
  readonly number: string | null;
  readonly issuedAt: Date;
  readonly total: Money;
  readonly status: 'DRAFT' | 'OPEN' | 'PAID' | 'UNCOLLECTIBLE' | 'VOID';
  readonly hostedUrl: string | null;
  readonly pdfUrl: string | null;
}

/** A provider webhook, already verified and normalized into our vocabulary. */
export type BillingWebhookEvent =
  | { readonly type: 'SUBSCRIPTION_UPDATED'; readonly subscription: ProviderSubscription; readonly customerExternalId: string }
  | { readonly type: 'SUBSCRIPTION_CANCELLED'; readonly subscriptionExternalId: string }
  | { readonly type: 'PAYMENT_SUCCEEDED'; readonly subscriptionExternalId: string; readonly invoice: InvoiceSummary }
  | { readonly type: 'PAYMENT_FAILED'; readonly subscriptionExternalId: string; readonly attemptCount: number }
  | { readonly type: 'TRIAL_ENDING'; readonly subscriptionExternalId: string; readonly endsAt: Date }
  | { readonly type: 'UNKNOWN'; readonly rawType: string };

export interface BillingProvider {
  readonly name: string;

  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;
  updateCustomer(externalId: string, input: Partial<CreateCustomerInput>): Promise<void>;

  createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription>;
  changeSubscription(input: ChangeSubscriptionInput): Promise<ProviderSubscription>;
  cancelSubscription(externalId: string, atPeriodEnd: boolean): Promise<ProviderSubscription>;

  listInvoices(customerExternalId: string, limit: number): Promise<readonly InvoiceSummary[]>;
  /** URL for the provider-hosted billing portal, so we never handle card data. */
  createBillingPortalSession(customerExternalId: string, returnUrl: string): Promise<string>;

  /**
   * Verifies the webhook signature and normalizes the payload.
   * Throws if the signature does not verify — an unverified webhook is not an event.
   */
  parseWebhook(rawBody: Buffer, signature: string): Promise<BillingWebhookEvent>;
}

/**
 * The provider used until Stripe is wired up (Phase 18).
 *
 * It fails loudly rather than pretending to succeed: a silent no-op billing provider in
 * production would mean customers using the product without a subscription ever being created.
 */
export class UnconfiguredBillingProvider implements BillingProvider {
  readonly name = 'unconfigured';

  private fail(operation: string): never {
    throw new Error(
      `Billing provider is not configured; cannot ${operation}. Set BILLING_PROVIDER and its credentials.`,
    );
  }

  createCustomer(): Promise<ProviderCustomer> {
    this.fail('create a customer');
  }
  updateCustomer(): Promise<void> {
    this.fail('update a customer');
  }
  createSubscription(): Promise<ProviderSubscription> {
    this.fail('create a subscription');
  }
  changeSubscription(): Promise<ProviderSubscription> {
    this.fail('change a subscription');
  }
  cancelSubscription(): Promise<ProviderSubscription> {
    this.fail('cancel a subscription');
  }
  listInvoices(): Promise<readonly InvoiceSummary[]> {
    this.fail('list invoices');
  }
  createBillingPortalSession(): Promise<string> {
    this.fail('open the billing portal');
  }
  parseWebhook(): Promise<BillingWebhookEvent> {
    this.fail('parse a webhook');
  }
}

export interface SubscriptionQuote {
  readonly planCode: string;
  readonly interval: BillingInterval;
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly taxTreatment: string;
  readonly taxRatePercent: number;
}
