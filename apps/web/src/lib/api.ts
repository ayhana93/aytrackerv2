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

/**
 * The CSRF token, from wherever this deployment makes it available.
 *
 * The token is a cookie that is script-readable *by design* — that is how double-submit works.
 * But "script-readable" means readable by script on the cookie's own site, and this product is
 * routinely deployed with the API and the web app on two different sites (on Railway,
 * `…api-production.up.railway.app` and `…web-production.up.railway.app`). There the browser sends
 * `ay_csrf` faithfully with every request and this function can never see it, so no header was
 * ever set and the server refused every mutation with `auth.csrf_failed` — a 403 that reads as
 * "you don't have access" and was nothing of the sort.
 *
 * So the cookie is tried first, which is correct and free when both halves share a site, and
 * `/auth/me` supplies the same value otherwise. `apiRequest` caches it from any response that
 * carries one.
 */
let cachedCsrfToken: string | null = null;

function csrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = /(?:^|;\s*)ay_csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function csrfToken(): string | null {
  return csrfCookie() ?? cachedCsrfToken;
}

/**
 * Ask `/auth/me` for the token, once, and remember it.
 *
 * Concurrent callers share one in-flight request: an admin screen that fires three mutations at
 * once should not send three identical round trips before any of them starts.
 */
let csrfRefresh: Promise<string | null> | null = null;

async function refreshCsrfToken(): Promise<string | null> {
  csrfRefresh ??= (async () => {
    try {
      const response = await fetch(new URL('/api/v1/auth/me', apiBaseUrl()), {
        credentials: 'include',
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { csrfToken?: unknown };
      return typeof body.csrfToken === 'string' ? body.csrfToken : null;
    } catch {
      // Unreachable API. The caller's own request is about to fail with a better message than
      // anything this helper could produce.
      return null;
    } finally {
      csrfRefresh = null;
    }
  })();

  const token = await csrfRefresh;
  if (token) cachedCsrfToken = token;
  return token;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly query?: Record<string, string | number | undefined>;
  readonly signal?: AbortSignal;
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
  retried = false,
): Promise<T> {
  const url = new URL(`/api/v1${path}`, apiBaseUrl());
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  if (method !== 'GET') {
    // Fetched rather than skipped when unknown. A mutation sent without the header is refused by
    // the server, and "refused" is indistinguishable from a permission problem in the response.
    const token = csrfToken() ?? (await refreshCsrfToken());
    if (token) headers['x-csrf-token'] = token;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      // Without this the session cookie is simply not sent and every call is a 401.
      credentials: 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // `fetch` rejects with a bare TypeError when the API cannot be reached at all — the service
    // is down, DNS fails, the origin is not on the CORS allow-list. Left as a TypeError it looks
    // to a caller like a bug in its own code, so the sign-up screen said "registration failed"
    // during an outage in which nothing about the registration was wrong. Given a status of 0 it
    // becomes a distinguishable condition callers can report honestly.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network.unreachable', 'NETWORK', 'The API could not be reached.');
  }

  if (!response.ok) {
    // A proxy or a crash can return HTML where JSON was expected. Parsing defensively means the
    // user sees "something went wrong" rather than a JSON syntax error from deep in the client.
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;

    /**
     * A rejected CSRF token is worth exactly one retry.
     *
     * The cached token can go stale — a second tab signed in again, or the session was reissued —
     * and the failure is invisible to the person, who sees a permission error for a button they
     * are perfectly entitled to press. `retry` guards against a loop when the server refuses the
     * fresh token too.
     */
    if (body?.error?.code === 'auth.csrf_failed' && !retried) {
      cachedCsrfToken = null;
      const token = await refreshCsrfToken();
      if (token) return apiRequest<T>(path, options, true);
    }

    throw new ApiError(
      response.status,
      body?.error?.code ?? 'http.error',
      body?.error?.kind ?? 'UNKNOWN',
      body?.error?.code ?? `Request failed with ${response.status}`,
      body?.error?.details,
    );
  }

  if (response.status === 204) return undefined as T;

  const payload = (await response.json()) as T;
  // `/auth/me` carries the token for deployments where the cookie is on another site. Cached in
  // one place so no screen has to know that this is how it arrives.
  const carried = (payload as { csrfToken?: unknown } | null)?.csrfToken;
  if (typeof carried === 'string') cachedCsrfToken = carried;
  return payload;
}
