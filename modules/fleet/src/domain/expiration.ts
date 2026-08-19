import type { VehicleId } from '@aytracker/types';

/**
 * Document expiration.
 *
 * Deliberately generic. Insurance, inspections, vignettes, licences and — later — worker
 * qualifications and certifications all answer the same question: what runs out, when, and how
 * long before that should someone be told. Modelling it once means the notifications module,
 * when it arrives, subscribes to one abstraction rather than six.
 */

export type ExpirationSeverity = 'OK' | 'DUE_SOON' | 'CRITICAL' | 'EXPIRED';

export interface ExpirableItem {
  readonly id: string;
  readonly subjectId: VehicleId | string;
  readonly subjectType: 'VEHICLE' | 'DRIVER' | 'WORKER';
  readonly kind: string;
  readonly name: string;
  readonly expiresAt: Date | null;
  /** Days before expiry at which warning starts. */
  readonly reminderDays: number;
}

export interface ExpirationStatus {
  readonly item: ExpirableItem;
  readonly severity: ExpirationSeverity;
  /** Negative once expired. */
  readonly daysRemaining: number | null;
  /** Message key, resolved by the presentation layer. */
  readonly messageKey: 'fleet.document_expiring' | 'fleet.document_expired' | null;
}

/** Inside this many days, a warning escalates from DUE_SOON to CRITICAL. */
export const CRITICAL_THRESHOLD_DAYS = 7;

export function evaluateExpiration(item: ExpirableItem, now: Date): ExpirationStatus {
  if (item.expiresAt === null) {
    return { item, severity: 'OK', daysRemaining: null, messageKey: null };
  }

  // Whole days, floored, so "expires in 0 days" means today rather than a fraction.
  const daysRemaining = Math.floor(
    (item.expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
  );

  if (daysRemaining < 0) {
    return {
      item,
      severity: 'EXPIRED',
      daysRemaining,
      messageKey: 'fleet.document_expired',
    };
  }
  if (daysRemaining <= CRITICAL_THRESHOLD_DAYS) {
    return { item, severity: 'CRITICAL', daysRemaining, messageKey: 'fleet.document_expiring' };
  }
  if (daysRemaining <= item.reminderDays) {
    return { item, severity: 'DUE_SOON', daysRemaining, messageKey: 'fleet.document_expiring' };
  }
  return { item, severity: 'OK', daysRemaining, messageKey: null };
}

/** Everything needing attention, most urgent first. */
export function pendingExpirations(
  items: readonly ExpirableItem[],
  now: Date,
): readonly ExpirationStatus[] {
  const severityOrder: Readonly<Record<ExpirationSeverity, number>> = {
    EXPIRED: 0,
    CRITICAL: 1,
    DUE_SOON: 2,
    OK: 3,
  };

  return items
    .map((item) => evaluateExpiration(item, now))
    .filter((status) => status.severity !== 'OK')
    .sort((a, b) => {
      const bySeverity = severityOrder[a.severity] - severityOrder[b.severity];
      if (bySeverity !== 0) return bySeverity;
      return (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0);
    });
}
