import { createHash, randomBytes } from 'node:crypto';
import type { ActorType } from '@aytracker/types';

/**
 * Session tokens.
 *
 * The cookie holds a high-entropy random token. The database holds only its SHA-256, so a
 * database dump does not hand over live sessions. SHA-256 (not Argon2) is correct here: the
 * token is 256 bits of randomness, not a low-entropy human secret, so there is nothing to
 * brute-force and lookup must stay a single indexed read.
 */

export const SESSION_TOKEN_BYTES = 32;
export const SESSION_COOKIE_NAME = 'ay_session';
export const CSRF_COOKIE_NAME = 'ay_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export interface IssuedSessionToken {
  /** Sent to the client. Never stored. */
  readonly token: string;
  /** Stored. Never sent. */
  readonly tokenHash: string;
}

export function issueSessionToken(): IssuedSessionToken {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax' | 'strict' | 'none';
  readonly path: string;
  readonly maxAge: number;
  readonly domain?: string;
}

/**
 * Cookie flags.
 *
 * SameSite depends on whether the web app and the API share a registrable domain.
 *
 *   * With `domain` set (a custom domain, e.g. `.aytracker.example`), the web app and the API
 *     live under the same site and `Lax` is strictly better: it still lets the session survive a
 *     top-level redirect back from somewhere like a billing portal, and it needs no `Secure`
 *     requirement to work over local HTTP.
 *   * Without it — the default on a fresh deploy, e.g. Railway's per-service `*.up.railway.app`
 *     domains, which are themselves separate public-suffix entries — the web origin and the API
 *     origin are cross-site. `Lax` cookies are simply never attached to a `fetch`/`XHR` request in
 *     that case, so every call after login would 401 no matter how the client sends the request.
 *     `None` is what cross-site fetch-based auth requires, and it is safe here because it is only
 *     ever paired with `Secure` (browsers reject `None` without it) and because mutations are
 *     additionally guarded by the CSRF double-submit token below, independent of SameSite.
 */
export function sessionCookieOptions(input: {
  ttlSeconds: number;
  secure: boolean;
  domain?: string | undefined;
}): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: input.secure,
    sameSite: input.domain ? 'lax' : input.secure ? 'none' : 'lax',
    path: '/',
    maxAge: input.ttlSeconds,
    ...(input.domain ? { domain: input.domain } : {}),
  };
}

export const DEFAULT_SESSION_TTL_SECONDS: Readonly<Record<ActorType, number>> = {
  // Admins re-authenticate daily.
  USER: 12 * 60 * 60,
  // A worker must not be logged out mid-shift; 16 h covers the longest legal shift plus overtime.
  WORKER: 16 * 60 * 60,
  DRIVER: 16 * 60 * 60,
};

export interface SessionRecord {
  readonly id: string;
  readonly actorType: ActorType;
  readonly organizationId: string | null;
  readonly userId: string | null;
  readonly workerId: string | null;
  readonly driverId: string | null;
  readonly permissions: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export type SessionRejectionReason = 'EXPIRED' | 'REVOKED' | 'NO_TENANT';

export type SessionValidation =
  { readonly valid: true } | { readonly valid: false; readonly reason: SessionRejectionReason };

export function validateSession(session: SessionRecord, now: Date): SessionValidation {
  if (session.revokedAt !== null) return { valid: false, reason: 'REVOKED' };
  if (session.expiresAt.getTime() <= now.getTime()) return { valid: false, reason: 'EXPIRED' };
  if (session.actorType !== 'USER' && session.organizationId === null) {
    return { valid: false, reason: 'NO_TENANT' };
  }
  return { valid: true };
}

/**
 * Whether a session's `lastSeenAt` is stale enough to be worth a write.
 *
 * Updating it on every request would turn a read-only page load into a write; once a minute is
 * enough for idle-timeout accounting.
 */
export function shouldTouchSession(lastSeenAt: Date, now: Date, thresholdSeconds = 60): boolean {
  return now.getTime() - lastSeenAt.getTime() >= thresholdSeconds * 1000;
}

/**
 * Double-submit CSRF token. The value is readable by JS (so the SPA can echo it in a header)
 * while the session cookie is not; an attacker on another origin can cause the browser to send
 * the session cookie but cannot read the CSRF cookie to construct the matching header.
 */
export function issueCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}
