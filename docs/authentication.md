# Authentication

Three kinds of actor, one session mechanism, and one rule that makes the whole thing work:
**everything that matters is read from the server-side session row.**

---

## 1. Actors

| Actor    | Credential                                | Session TTL | Portal |
| -------- | ----------------------------------------- | ----------- | ------ |
| `USER`   | Email + password                          | 12 h        | Admin  |
| `WORKER` | Organization slug + employee number + PIN | 16 h        | Worker |
| `DRIVER` | Organization slug + driver code + PIN     | 16 h        | Driver |

Worker and driver TTLs are longer than the admin's on purpose: being logged out mid-shift is an
operational failure, and 16 hours covers the longest legal shift plus overtime.

A person can be all three. `Worker.userId` and `Driver.userId` link the profiles; `Driver.workerId`
links a driver who also works the floor. Each still authenticates through its own path and gets
its own session with its own permissions — a supervisor who clocks in does not carry supervisor
permissions into the worker portal.

---

## 2. Sessions

### Token handling

```
issueSessionToken()  →  { token, tokenHash }
                          │        └── SHA-256, stored in `sessions.tokenHash`
                          └── 32 random bytes, base64url, sent as an HTTP-only cookie
```

The database stores only the hash, so a database dump does not hand over live sessions.

SHA-256 rather than Argon2 is correct here: the token is 256 bits of entropy, not a low-entropy
human secret. There is nothing to brute-force, and lookup must stay a single indexed read.

### Cookies

```ts
{
  httpOnly: true,          // JS cannot read it — an XSS cannot exfiltrate the session
  secure: <https>,         // off only for plain-HTTP local development
  sameSite: 'lax',
  path: '/',
  maxAge: <ttl>,
}
```

**Why `Lax` and not `Strict`:** the admin app links out to Stripe's billing portal and back, and
`Strict` drops the cookie on that return navigation — the user lands logged out. `Lax` still
blocks the cross-site POST that CSRF needs, and the double-submit token below covers the rest.

### What the session carries

```ts
{ id, actorType, organizationId, userId | workerId | driverId, permissions[], expiresAt, revokedAt }
```

`ActorContext` is built from this row and nothing else. **No route anywhere reads an actor id,
organization id, role, or permission from a request.** The worker and driver route files contain
no `workerId` or `driverId` parameter at all — which is what makes "worker A cannot act on worker
B" structural rather than a check someone has to remember.

### Permission snapshot

Permissions are copied onto the session at issue time, making authorization one indexed read
instead of a role join per request.

The cost is invalidation. `SessionService.revokeForActor` must be called when:

| Event                             | Wired?                                                          |
| --------------------------------- | --------------------------------------------------------------- |
| A worker or driver is deactivated | Yes — `PATCH /admin/workers/:workerId`, worker and driver alike |
| A worker's PIN is reset           | Yes — same route; a changed credential ends the old sessions    |
| A member's role changes           | No route exists yet that changes one                            |
| A role's permissions change       | No route exists yet that changes them                           |
| A membership is removed           | No route exists yet that removes one                            |

This is the tradeoff's sharp edge, and it was open for a while: `revokeForActor` existed and
nothing called it, so a worker marked INACTIVE kept a valid session for the rest of its sixteen
hours — still able to clock in, change position and stream their location, because the request
path reads the snapshot and never re-reads the worker's status. The first two rows above are now
enforced by tests in `tests/integration/admin-api.test.ts`. **The last three rows are the standing
obligation: the route that first changes a role, a role's permissions or a membership has to call
`revokeForActor` in the same request, or it reopens exactly this hole.**

The route reports `sessionsRevoked` so the screen can say what just happened — an admin resetting
a PIN mid-shift has stopped that worker's phone reporting until they sign in with the new one.

Separately, a password change invalidates every session issued before it without a sweep:
`users.credentialsChangedAt` is compared against `sessions.createdAt` on every lookup.

---

## 3. Password and PIN hashing

Argon2id for both. Parameters are exported so a benchmark can assert they have not drifted down:

```ts
ARGON2_PASSWORD_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 }; // 19 MiB
ARGON2_PIN_OPTIONS = { memoryCost: 47_104, timeCost: 3, parallelism: 1 }; // 46 MiB
```

PIN costs are **higher** than password costs. A 6-digit PIN has 10⁶ possibilities, so the hash
parameters have to do more work per guess — and PIN verification is far less frequent than
login, so the extra cost is affordable.

### PIN policy

- 4–8 digits, numeric only.
- Repeated digits (`0000`, `1111`) and simple sequences (`1234`, `4321`) rejected — those are
  what an attacker tries first.
- `generatePin()` produces PINs that satisfy the policy.

The hash parameters are not the real defence for a PIN. These are:

1. **Per-identity lockout** — 5 failures, then exponential back-off from 60 s to 15 min.
2. **Per-IP rate limiting** — 5 attempts/minute on the PIN endpoints.
3. **Organization scoping** — a PIN is only usable with a known employee number inside one
   tenant.

Layers 1 and 2 stop different attacks: one attacker grinding one worker's PIN, versus one
attacker spraying one PIN across many workers.

---

## 4. Not leaking who exists

Every failure path returns `401 auth.invalid_credentials` and takes comparable time.

| Situation                     | Response                   |
| ----------------------------- | -------------------------- |
| Unknown organization slug     | `auth.invalid_credentials` |
| Unknown employee number       | `auth.invalid_credentials` |
| Correct number, wrong PIN     | `auth.invalid_credentials` |
| Worker exists but is inactive | `auth.invalid_credentials` |

When the identity does not exist, `burnVerificationTime()` performs a real Argon2 verification
against a dummy hash, so response timing does not distinguish the cases. Without it the login
form is an employee-directory oracle.

Two situations are reported distinctly, deliberately:

- `429 auth.account_locked` — the user needs to know to wait, and by then the attacker already
  knows the identity exists.
- `403 auth.organization_suspended` — an operational state the customer must be told about.

---

## 5. CSRF

Double-submit tokens on every mutating method.

```
login  →  Set-Cookie: ay_session (HttpOnly)   ← the credential
          Set-Cookie: ay_csrf    (readable)   ← the proof of same-origin

mutation → Cookie: ay_session; ay_csrf
           x-csrf-token: <must equal the ay_csrf cookie>
```

An attacker on another origin can cause the browser to send the session cookie but cannot read
the CSRF cookie to construct the matching header. Combined with `SameSite=Lax` (which already
blocks cross-site form POSTs), a cross-origin mutation needs both a same-site context and the
ability to read a cookie — which is to say, it needs to already be us.

Enforced in `apps/api/src/plugins/authentication.ts` for POST, PUT, PATCH and DELETE. Tested in
`api-security.test.ts`.

---

## 6. Rate limiting

| Endpoint                  | Limit                    |
| ------------------------- | ------------------------ |
| `POST /auth/login`        | 10/min per IP            |
| `POST /auth/worker/login` | 5/min per IP             |
| `POST /auth/driver/login` | 5/min per IP             |
| `POST /tracking/points`   | 120/min per organization |
| Everything else           | 300/min                  |

Keyed by **organization** when authenticated and by IP otherwise. Keying purely by IP would let
one factory's shared NAT exhaust the limit for everyone behind it — which is exactly the
deployment shape a manufacturing customer has.

The GPS endpoint's high limit is sized for a driver sampling every 15 s with room for offline
replay bursts. High-frequency is not the same as unbounded.

---

## 7. Auditing

`auth_attempts` records every attempt: actor type, identifier (lowercased, never a secret),
outcome, IP, user agent. Short retention, pruned by a scheduled job.

`audit_logs` records logins, logouts, session revocations, and credential changes with
redaction applied — `redactMetadata` strips anything whose key normalizes to `password`, `pin`,
`token`, `secret`, `iban` and friends, and IP addresses are truncated to /24 (or /64 for IPv6).

Fastify's logger is configured to redact `authorization`, `cookie`, and any `password`/`pin`
body field at every level including trace.

---

## 8. Threats and responses

| Threat                                   | Response                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| Stolen session cookie                    | HTTP-only, Secure, short TTL, revocable, hash-only storage                     |
| XSS reading the token                    | HTTP-only cookie; no token in any response body                                |
| CSRF                                     | SameSite=Lax + double-submit token                                             |
| PIN brute force                          | Lockout + per-IP limit + tenant scoping + expensive hash                       |
| Employee enumeration                     | Uniform errors and equalized timing                                            |
| Session fixation                         | A new token is issued on every login; none is ever accepted from a parameter   |
| Privilege escalation via a stale session | Revocation on role change; `credentialsChangedAt` invalidation                 |
| Cross-tenant login                       | Slug resolves to an organization row; the session's tenant comes from that row |
| Database compromise                      | Argon2id credentials, SHA-256 session hashes, no plaintext secrets             |

---

## 9. Not yet implemented

Named so they are tracked rather than assumed.

- **Password reset** — token issue, single use, expiry, and rate limiting. Schema supports it.
- **Email verification** — `users.emailVerifiedAt` exists; the flow does not.
- **MFA for admins** — TOTP. The session model accommodates a second factor without change.
- **SSO / SAML** — enterprise requirement; `OrganizationMember` is the natural attachment point.
- **Device binding for driver sessions** — would reduce the value of a stolen driver cookie.
