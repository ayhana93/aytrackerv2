import { randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { ValidationError } from '@aytracker/domain';

/**
 * Password and PIN hashing.
 *
 * Argon2id everywhere. The parameters below target roughly 150–250 ms on a Railway-class
 * container; they are exported so a benchmark can assert they have not silently drifted down.
 */
export const ARGON2_PASSWORD_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP minimum for argon2id
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A 4–8 digit PIN has at most 10^8 possibilities, so the hash parameters cannot be the whole
 * defence. The real controls are per-worker lockout, per-IP rate limiting and the fact that a
 * PIN is only usable together with a known employee number inside one organization. Costs are
 * raised over the password profile because PIN verification is far less frequent than login.
 */
export const ARGON2_PIN_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 47_104, // 46 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return argon2.hash(password, ARGON2_PASSWORD_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash that
    // distinguishes this account from any other.
    return false;
  }
}

export async function hashPin(pin: string): Promise<string> {
  assertPinPolicy(pin);
  return argon2.hash(pin, ARGON2_PIN_OPTIONS);
}

export async function verifyPin(hash: string, pin: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pin);
  } catch {
    return false;
  }
}

/**
 * Burns comparable time when the identity does not exist, so response timing cannot be used to
 * enumerate valid employee numbers or emails.
 */
const DUMMY_HASH_PROMISE = argon2.hash('aytracker-timing-equalizer', ARGON2_PIN_OPTIONS);

export async function burnVerificationTime(): Promise<void> {
  const dummy = await DUMMY_HASH_PROMISE;
  await argon2.verify(dummy, 'wrong-value-on-purpose').catch(() => false);
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      'auth.password_too_short',
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (password.length > 256) {
    throw new ValidationError('auth.password_too_long', 'Password must be at most 256 characters.');
  }
}

export function assertPinPolicy(pin: string): void {
  if (!/^\d+$/.test(pin)) {
    throw new ValidationError('auth.pin_not_numeric', 'PIN must contain digits only.');
  }
  if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
    throw new ValidationError(
      'auth.pin_invalid_length',
      `PIN must be between ${MIN_PIN_LENGTH} and ${MAX_PIN_LENGTH} digits.`,
    );
  }
  if (isTriviallyGuessablePin(pin)) {
    throw new ValidationError(
      'auth.pin_too_weak',
      'PIN must not be a repeated digit or a simple sequence.',
    );
  }
}

/** Rejects 0000, 1111, 1234, 4321 and friends — the PINs an attacker tries first. */
export function isTriviallyGuessablePin(pin: string): boolean {
  if (/^(\d)\1*$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1] ?? 0) + 1);
  const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1] ?? 0) - 1);
  return ascending || descending;
}

export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Generates a random numeric PIN that satisfies the policy. */
export function generatePin(length = 6): string {
  if (length < MIN_PIN_LENGTH || length > MAX_PIN_LENGTH) {
    throw new ValidationError('auth.pin_invalid_length', 'Unsupported PIN length.');
  }
  for (;;) {
    const digits = [...randomBytes(length)].map((byte) => byte % 10).join('');
    if (!isTriviallyGuessablePin(digits)) return digits;
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // timingSafeEqual throws on length mismatch; compare against self to keep the cost similar.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
