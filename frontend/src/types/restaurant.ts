/**
 * The restaurant row as `GET /tenants` answers it, and the plan options every
 * restaurant form offers. One definition for the Super Admin's page and the
 * Salesperson's dashboard: the server scopes the rows, the client does not.
 */

/** `GET /countries`: what a restaurant may be created in or moved to (0084). */
export interface CountrySettings {
  readonly countries: readonly {
    readonly code: string; readonly name: string; readonly currency: string; readonly locale: string;
    readonly timezone: string; readonly billable: boolean; readonly offered: boolean;
  }[];
  readonly defaultCountry: string;
  readonly currencies: readonly string[];
  readonly salesMayChangeCountry: boolean;
}

export interface TenantSummary {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly address: string | null;
  readonly themeColor: string | null;
  readonly themeColorSecondary?: string | null;
  /** Registry key (shared `BUSINESS_TYPES`); absent from an older API, which only had restaurants. */
  readonly businessType?: string;
  readonly logoUrl: string | null;
  readonly status: string;
  readonly delinquentSince: string | null;
  readonly deactivatedAt: string | null;
  readonly deactivationReason: string | null;
  /** ISO 3166-1 alpha-2: the country whose tax law its bills are struck under (absent from an older API). */
  readonly country?: string;
  readonly defaultCurrency: string;
  readonly defaultTimezone: string;
  readonly createdAt: string;
  readonly subscriptionId: string | null;
  readonly subscriptionStatus: string | null;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly planVersionId: string | null;
  readonly planKey: string | null;
  readonly planName: string | null;
  readonly planVersion: number | null;
  readonly priceMinor: number | null;
  readonly priceCurrency: string | null;
  readonly billingPeriod: string | null;
  readonly ownerEmail: string | null;
  readonly ownerInviteStatus: string | null;
  readonly ownerName: string | null;
  readonly ownerPhone: string | null;
  readonly billingStatus: 'none' | 'paid' | 'due' | 'overdue' | 'void';
  readonly salesPersonId: string | null;
  readonly salesPersonName: string | null;
  readonly salesPersonEmail: string | null;
  readonly salesPersonPhone: string | null;
  readonly revenueMinor: number;
}

export interface PlanVersion {
  readonly planVersionId: string;
  readonly version: number;
  readonly priceMinor: number;
  readonly currency: string;
  readonly billingPeriod: string;
  readonly limits: Readonly<Record<string, number>>;
  readonly features: Readonly<Record<string, boolean>>;
  readonly publishedAt: string | null;
  readonly liveSubscriptions: number;
  readonly subscriptionsByStatus?: {
    readonly trialing: number; readonly active: number; readonly past_due: number;
  };
}

export interface Plan {
  readonly planId: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly versions: readonly PlanVersion[];
}

export interface PlanOption {
  readonly planVersionId: string;
  readonly planKey: string;
  readonly planName: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly billingPeriod: string;
  readonly label: string;
}
