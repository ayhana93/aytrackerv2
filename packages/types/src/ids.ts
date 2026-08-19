/**
 * Branded identifiers.
 *
 * The brand exists to stop the single most expensive class of multi-tenant bug: passing a
 * worker id where an organization id is expected. It costs nothing at runtime.
 */

declare const brand: unique symbol;

export type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export type OrganizationId = Brand<string, 'OrganizationId'>;
export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type RoleId = Brand<string, 'RoleId'>;

export type SiteId = Brand<string, 'SiteId'>;
export type WorkAreaId = Brand<string, 'WorkAreaId'>;
export type PositionId = Brand<string, 'PositionId'>;
export type WorkerId = Brand<string, 'WorkerId'>;
export type QualificationId = Brand<string, 'QualificationId'>;

export type ShiftId = Brand<string, 'ShiftId'>;
export type ShiftTypeId = Brand<string, 'ShiftTypeId'>;
export type ShiftBreakId = Brand<string, 'ShiftBreakId'>;
export type PositionSessionId = Brand<string, 'PositionSessionId'>;
export type ProductionEntryId = Brand<string, 'ProductionEntryId'>;

export type DriverId = Brand<string, 'DriverId'>;
export type VehicleId = Brand<string, 'VehicleId'>;
export type VehicleAssignmentId = Brand<string, 'VehicleAssignmentId'>;
export type TripId = Brand<string, 'TripId'>;

export type PlanId = Brand<string, 'PlanId'>;
export type PriceId = Brand<string, 'PriceId'>;
export type MarketId = Brand<string, 'MarketId'>;
export type FeatureId = Brand<string, 'FeatureId'>;
export type SubscriptionId = Brand<string, 'SubscriptionId'>;

export type RecommendationId = Brand<string, 'RecommendationId'>;

/**
 * Client-generated idempotency token. Every offline-capable mutation carries one.
 */
export type ClientActionId = Brand<string, 'ClientActionId'>;

/**
 * Narrowing helper for the boundary where an untyped string becomes a branded id.
 * Call it only after the value has been validated (shape *and* tenancy).
 */
export function asId<T extends Brand<string, string>>(value: string): T {
  return value as T;
}
