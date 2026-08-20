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

export const authApi = {
  me: () => apiRequest<MeResponse>('/auth/me'),
  login: (email: string, password: string) =>
    apiRequest<LoginResponse>('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => apiRequest<{ ok: true }>('/auth/logout', { method: 'POST' }),
};
