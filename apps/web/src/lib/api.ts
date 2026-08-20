/**
 * The browser's one way to reach the API.
 *
 * Every call goes through here so three things are true in one place rather than remembered at
 * each call site:
 *
 *   * **`credentials: 'include'`.** The session is an httpOnly cookie — deliberately unreadable
 *     from JavaScript, so an XSS cannot exfiltrate it. That only works if every request opts in
 *     to sending it.
 *   * **The CSRF token on every mutation.** The session cookie is `SameSite=Lax`, which stops
 *     the obvious cross-site POST; the double-submit token covers the rest. It is readable by
 *     script on purpose — that is the mechanism, not an oversight.
 *   * **Errors arrive as errors.** `fetch` resolves happily on a 403. A caller that forgets to
 *     check `response.ok` renders a permission error as data, so that check lives here.
 */

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly kind: string;
    readonly requestId?: string;
    readonly details?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly kind: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The caller is not signed in, or the session expired. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Signed in, but not allowed — a permission or an unpaid feature. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** The organization has not paid for this feature. Different message, different action. */
  get isEntitlement(): boolean {
    return this.kind === 'ENTITLEMENT_REQUIRED';
  }
}

function apiBaseUrl(): string {
  // Read at call time rather than module load: Next inlines NEXT_PUBLIC_* at build time, and a
  // module-level constant would bake a build-machine value into a container run elsewhere.
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

/** The CSRF cookie is script-readable by design; that is how double-submit works. */
function csrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = /(?:^|;\s*)ay_csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly query?: Record<string, string | number | undefined>;
  readonly signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`/api/v1${path}`, apiBaseUrl());
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  if (method !== 'GET') {
    const token = csrfToken();
    if (token) headers['x-csrf-token'] = token;
  }

  const response = await fetch(url, {
    method,
    headers,
    // Without this the session cookie is simply not sent and every call is a 401.
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    // A proxy or a crash can return HTML where JSON was expected. Parsing defensively means the
    // user sees "something went wrong" rather than a JSON syntax error from deep in the client.
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'http.error',
      body?.error?.kind ?? 'UNKNOWN',
      body?.error?.code ?? `Request failed with ${response.status}`,
      body?.error?.details,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
