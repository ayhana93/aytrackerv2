import { decideSampling as decide, DEFAULT_SAMPLING_POLICY } from '@aytracker/tracking';

/**
 * Thin adapter over the shared sampling rule.
 *
 * The rule itself lives in `@aytracker/tracking` — a pure package with no DOM — so the device
 * and the server evaluate the same logic. This file only reshapes the browser's inputs
 * (`GeolocationCoordinates` uses `null` where the domain wants `null | number`, and the policy
 * arrives from the server as two overrides rather than a whole object).
 */

export interface GeoPointLike {
  readonly latitude: number;
  readonly longitude: number;
}

export interface SamplingInput {
  readonly lastSentAt: Date | null;
  readonly lastSentPoint: GeoPointLike | null;
  readonly current: GeoPointLike;
  readonly currentSpeedMps: number | null;
  readonly batteryLevel: number | null;
  readonly now: Date;
  /** Server-supplied floor. The device may sample less often, never more. */
  readonly minIntervalSeconds: number;
  readonly minDistanceMeters: number;
}

export function decideSampling(input: SamplingInput): { shouldSend: boolean; reason: string } {
  const decision = decide({
    lastSentAt: input.lastSentAt,
    lastSentPoint: input.lastSentPoint,
    current: input.current,
    currentSpeedMps: input.currentSpeedMps,
    batteryLevel: input.batteryLevel,
    now: input.now,
    policy: {
      ...DEFAULT_SAMPLING_POLICY,
      minIntervalSeconds: input.minIntervalSeconds,
      minDistanceMeters: input.minDistanceMeters,
    },
  });
  return { shouldSend: decision.shouldSend, reason: decision.reason };
}
