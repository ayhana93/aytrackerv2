/**
 * Brute-force lockout for PIN and password authentication.
 *
 * Two independent layers, because they stop different attacks:
 *   * Per-identity lockout (here) stops an attacker grinding one worker's PIN.
 *   * Per-IP rate limiting (in the API) stops one attacker spraying many identities.
 *
 * Back-off is exponential and capped, so a worker who fat-fingers their PIN twice is not locked
 * out of their shift for an hour.
 */

export interface LockoutPolicy {
  /** Failures tolerated before the first lock. */
  readonly threshold: number;
  /** Lock duration for the first lock, doubling each subsequent time. */
  readonly baseLockSeconds: number;
  readonly maxLockSeconds: number;
}

export const DEFAULT_PIN_LOCKOUT: LockoutPolicy = {
  threshold: 5,
  baseLockSeconds: 60,
  maxLockSeconds: 900,
};

export const DEFAULT_PASSWORD_LOCKOUT: LockoutPolicy = {
  threshold: 10,
  baseLockSeconds: 60,
  maxLockSeconds: 3600,
};

export interface LockoutState {
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

export function isLockedOut(state: LockoutState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

export function secondsUntilUnlock(state: LockoutState, now: Date): number {
  if (!isLockedOut(state, now)) return 0;
  return Math.ceil((state.lockedUntil!.getTime() - now.getTime()) / 1000);
}

/** Next state after a failed attempt. */
export function registerFailure(
  state: LockoutState,
  now: Date,
  policy: LockoutPolicy = DEFAULT_PIN_LOCKOUT,
): LockoutState {
  const failedAttempts = state.failedAttempts + 1;
  if (failedAttempts < policy.threshold) {
    return { failedAttempts, lockedUntil: null };
  }
  const lockNumber = failedAttempts - policy.threshold; // 0 for the first lock
  const seconds = Math.min(policy.baseLockSeconds * 2 ** lockNumber, policy.maxLockSeconds);
  return { failedAttempts, lockedUntil: new Date(now.getTime() + seconds * 1000) };
}

/** Next state after a successful authentication. */
export function registerSuccess(): LockoutState {
  return { failedAttempts: 0, lockedUntil: null };
}
