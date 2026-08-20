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
  readonly organizationName: string | null;
  readonly userId: string | null;
  readonly permissions: readonly string[];
  readonly features: readonly string[];
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

export const authApi = {
  me: () => apiRequest<MeResponse>('/auth/me'),
  login: (email: string, password: string) =>
    apiRequest<LoginResponse>('/auth/login', { method: 'POST', body: { email, password } }),
  register: (input: RegisterInput) =>
    apiRequest<RegisterResponse>('/auth/register', { method: 'POST', body: input }),
  logout: () => apiRequest<{ ok: true }>('/auth/logout', { method: 'POST' }),
};
