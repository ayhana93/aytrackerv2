import type { GeoPoint } from '@aytracker/types';
import { haversineMeters } from './geo.js';

/**
 * Adaptive GPS sampling.
 *
 * "Do not send GPS every second" is easy to say and easy to get wrong in the direction of
 * uselessness. The policy here trades three things off:
 *   * battery — the dominant cost on a driver's phone across an 8-hour shift;
 *   * fidelity — a route sampled too coarsely cuts corners and under-reports distance;
 *   * write volume — the ingestion endpoint is the highest-frequency writer in the system.
 *
 * The device applies this policy locally; the server treats the result as a *floor*, not a
 * promise, and independently rejects points that arrive faster than the configured minimum.
 */

export interface SamplingPolicy {
  /** Never sample more often than this, whatever else is true. */
  readonly minIntervalSeconds: number;
  /** Always sample at least this often while moving, even standing still. */
  readonly maxIntervalSeconds: number;
  /** Emit a point once the vehicle has moved this far since the last one. */
  readonly minDistanceMeters: number;
  /** Below this speed the vehicle counts as stationary and sampling slows right down. */
  readonly stationarySpeedMps: number;
  /** Interval used while stationary. */
  readonly stationaryIntervalSeconds: number;
  /** Below this battery level, sampling backs off to the conservative profile. */
  readonly lowBatteryThreshold: number;
  readonly lowBatteryIntervalSeconds: number;
}

export const DEFAULT_SAMPLING_POLICY: SamplingPolicy = {
  minIntervalSeconds: 15,
  maxIntervalSeconds: 60,
  minDistanceMeters: 50,
  stationarySpeedMps: 1.5, // ~5 km/h
  stationaryIntervalSeconds: 120,
  lowBatteryThreshold: 0.15,
  lowBatteryIntervalSeconds: 180,
};

export interface SamplingInput {
  readonly lastSentAt: Date | null;
  readonly lastSentPoint: GeoPoint | null;
  readonly current: GeoPoint;
  readonly currentSpeedMps: number | null;
  readonly batteryLevel: number | null;
  readonly now: Date;
  readonly policy?: SamplingPolicy;
}

export interface SamplingDecision {
  readonly shouldSend: boolean;
  readonly reason:
    | 'FIRST_POINT'
    | 'DISTANCE_THRESHOLD'
    | 'INTERVAL_ELAPSED'
    | 'BELOW_MIN_INTERVAL'
    | 'NO_SIGNIFICANT_CHANGE';
  /** Suggested delay until the next evaluation, so the device can schedule rather than poll. */
  readonly nextCheckSeconds: number;
}

export function decideSampling(input: SamplingInput): SamplingDecision {
  const policy = input.policy ?? DEFAULT_SAMPLING_POLICY;

  if (input.lastSentAt === null || input.lastSentPoint === null) {
    return { shouldSend: true, reason: 'FIRST_POINT', nextCheckSeconds: policy.minIntervalSeconds };
  }

  const elapsed = (input.now.getTime() - input.lastSentAt.getTime()) / 1000;

  // Hard floor. Protects the ingestion endpoint from a misbehaving or hostile client.
  if (elapsed < policy.minIntervalSeconds) {
    return {
      shouldSend: false,
      reason: 'BELOW_MIN_INTERVAL',
      nextCheckSeconds: Math.ceil(policy.minIntervalSeconds - elapsed),
    };
  }

  const interval = targetIntervalSeconds(input, policy);
  const moved = haversineMeters(input.lastSentPoint, input.current);

  if (moved >= policy.minDistanceMeters) {
    return {
      shouldSend: true,
      reason: 'DISTANCE_THRESHOLD',
      nextCheckSeconds: policy.minIntervalSeconds,
    };
  }

  if (elapsed >= interval) {
    return {
      shouldSend: true,
      reason: 'INTERVAL_ELAPSED',
      nextCheckSeconds: policy.minIntervalSeconds,
    };
  }

  return {
    shouldSend: false,
    reason: 'NO_SIGNIFICANT_CHANGE',
    nextCheckSeconds: Math.ceil(interval - elapsed),
  };
}

/** The interval the current conditions call for. */
export function targetIntervalSeconds(
  input: Pick<SamplingInput, 'currentSpeedMps' | 'batteryLevel'>,
  policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY,
): number {
  if (input.batteryLevel !== null && input.batteryLevel <= policy.lowBatteryThreshold) {
    return policy.lowBatteryIntervalSeconds;
  }
  if (input.currentSpeedMps !== null && input.currentSpeedMps < policy.stationarySpeedMps) {
    return policy.stationaryIntervalSeconds;
  }
  return policy.maxIntervalSeconds;
}

/**
 * Server-side admission control for an ingested batch.
 *
 * The device decides what to send; the server decides what to keep. Points arriving faster than
 * the policy floor are dropped rather than rejected with an error — an over-eager client should
 * not be able to fail a driver's whole batch, and should not be able to flood the table either.
 */
export function admitPoints<T extends { timestamp: Date }>(
  points: readonly T[],
  input: { lastAcceptedAt: Date | null; minIntervalSeconds: number },
): { readonly accepted: readonly T[]; readonly dropped: number } {
  const ordered = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const accepted: T[] = [];
  let cursor = input.lastAcceptedAt;

  for (const point of ordered) {
    if (
      cursor === null ||
      (point.timestamp.getTime() - cursor.getTime()) / 1000 >= input.minIntervalSeconds
    ) {
      accepted.push(point);
      cursor = point.timestamp;
    }
  }

  return { accepted, dropped: ordered.length - accepted.length };
}
