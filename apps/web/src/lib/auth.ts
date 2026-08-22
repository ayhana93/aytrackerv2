'use client';

import { apiRequest } from './api';

/**
 * `/api/v1/auth` — session lifecycle for the admin app.
 *
 * Kept separate from `lib/admin.ts`: that file is the data an authenticated admin reads, this is
 * the session itself, and the login page needs this before any of that exists.
 */

export interface MeResponse {
  readonly actorType: 'USER' | 'WORKER' | 'DRIVER';
  readonly organizationId: string;
  /** What a worker or driver types on their own login screen. */
  readonly organizationSlug: string | null;
  /** What the organization is called on screen — its branding name, or its registered one. */
  readonly organizationName: string | null;
  /** The organization's chosen logo, or null when it has none and the monogram stands in. */
  readonly organizationLogoUrl: string | null;
  readonly userId: string | null;
  readonly permissions: readonly string[];
  readonly features: readonly string[];
  /**
   * The double-submit token, for deployments where the API and the web app are different sites
   * and the browser will not let this app read the cookie. `apiRequest` caches it; no screen
   * needs to touch it.
   */
  readonly csrfToken: string;
}

export interface LoginResponse {
  readonly actorType: 'USER';
  readonly organizationId: string;
  readonly permissions: readonly string[];
  readonly expiresAt: string;
}

export interface RegisterResponse extends LoginResponse {
  /** The tenant key workers and drivers type on their own login screens. */
  readonly organizationSlug: string;
}

export interface RegisterInput {
  readonly companyName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly password: string;
}

/**
 * What a worker or a driver types in.
 *
 * The organization slug is here because a PIN is only unique inside one tenant — it is a lookup
 * key that scopes the login, never a claim about who the person is. Everything that decides what
 * they may do is read from the session row the server writes.
 */
export interface WorkerLoginInput {
  readonly organizationSlug: string;
  readonly employeeNumber: string;
  readonly pin: string;
}

export interface DriverLoginInput {
  readonly organizationSlug: string;
  readonly driverCode: string;
  readonly pin: string;
}

export const authApi = {
  me: () => apiRequest<MeResponse>('/auth/me'),
  login: (email: string, password: string) =>
    apiRequest<LoginResponse>('/auth/login', { method: 'POST', body: { email, password } }),
  workerLogin: (input: WorkerLoginInput) =>
    apiRequest<{ actorType: 'WORKER' }>('/auth/worker/login', { method: 'POST', body: input }),
  driverLogin: (input: DriverLoginInput) =>
    apiRequest<{ actorType: 'DRIVER' }>('/auth/driver/login', { method: 'POST', body: input }),
  register: (input: RegisterInput) =>
    apiRequest<RegisterResponse>('/auth/register', { method: 'POST', body: input }),
  logout: () => apiRequest<{ ok: true }>('/auth/logout', { method: 'POST' }),
};
