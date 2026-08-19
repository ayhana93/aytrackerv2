# Deployment

Railway. Two services, one database, Redis only if it is actually required.

---

## 1. Topology

```
Railway project: aytracker
├── web         Next.js       → APP_URL
├── api         Fastify       → API_URL
├── postgres    PostgreSQL 16
└── redis       (only when a second API replica exists)
```

**Redis is not deployed initially and that is deliberate.** Its only jobs would be distributed
rate limiting and session caching. With one API replica the in-process rate limiter is correct,
and sessions are a single indexed read. Redis becomes necessary the moment there are two
replicas — before then it is a component to operate for no benefit.

---

## 2. Environment variables

Full list in `.env.example`. The ones without a safe default:

| Variable               | Service | Notes                                                                                   |
| ---------------------- | ------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | api     | Use the **non-owner** app role in production ([multi-tenancy.md](multi-tenancy.md) § 2) |
| `SESSION_SECRET`       | api     | ≥ 32 chars. `openssl rand -base64 48`                                                   |
| `APP_URL` / `API_URL`  | both    | Must be `https` in production — checked at boot                                         |
| `CORS_ALLOWED_ORIGINS` | api     | Explicit allow-list                                                                     |
| `STRIPE_*`             | api     | Required when `BILLING_PROVIDER=stripe`                                                 |
| `OBJECT_STORAGE_*`     | api     | Branding assets                                                                         |

`parseServerEnv` validates everything at boot and **exits with a list of what is wrong**. A
misconfigured deploy fails in the first second, not on the first request that happens to need the
missing value. Conditional requirements are enforced too — `BILLING_PROVIDER=stripe` without a
secret key will not start.

---

## 3. Build and start

**api**

```
Build:  pnpm install --frozen-lockfile && pnpm db:generate && pnpm --filter @aytracker/api build
Start:  pnpm --filter @aytracker/database migrate:deploy && node apps/api/dist/server.js
```

**web**

```
Build:  pnpm install --frozen-lockfile && pnpm --filter @aytracker/web build
Start:  pnpm --filter @aytracker/web start
```

Migrations run at API start, before the server listens. Railway's health check gates the traffic
switch, so a failed migration means the old version keeps serving.

Health checks: `/health/ready` for the API, `/` for web.

---

## 4. Migrations

```
pnpm db:migrate           create + apply (development)
pnpm db:migrate:deploy    apply only (CI/production)
pnpm db:migrate:status    check for drift
```

Rules:

1. Never alter a production schema by hand.
2. Review generated SQL before committing — Prisma will happily generate a destructive rename.
3. Schema and migration in one commit.
4. Breaking changes use expand/contract ([database.md](database.md) § 5).

### Migration user

Migrations need the owner role; the application uses the non-owner app role. Two URLs:

```
DATABASE_URL           → aytracker_app   (application)
MIGRATION_DATABASE_URL → aytracker_owner (migration step only)
```

---

## 5. Rollback

**Application** — Railway keeps previous deployments; redeploy the last good one. Safe as long as
the schema is compatible, which expand/contract guarantees.

**Schema** — forward-only. A "rollback migration" that drops a column destroys data written since
the deploy. To undo a schema change, write a new migration that reverses it, after checking what
has been written in the meantime.

That is why step 4 above matters: with expand/contract, an application rollback never needs a
schema rollback.

---

## 6. Backups

| Aspect     | Setting                                                  |
| ---------- | -------------------------------------------------------- |
| Frequency  | Railway automated daily + PITR                           |
| Retention  | 30 days                                                  |
| Encryption | At rest, provider-managed                                |
| Off-site   | Weekly `pg_dump` to object storage, separate credentials |

The off-site copy exists because a provider-managed backup shares a failure domain with the
provider.

### Restore procedure

```
1. Provision a new database instance
2. Restore the target snapshot
3. Point a staging API at it and verify:
     - row counts on organizations, workers, shifts, driver_trips
     - the newest shift and trip look plausible
     - a login works
4. Repoint DATABASE_URL and restart
```

**Test restoration before real customers depend on the system.** An untested backup is a
hypothesis, not a backup. Target: quarterly restore drill, recorded with its duration.

Targets: **RPO** ≤ 24 h (PITR reduces this to minutes), **RTO** ≤ 4 h.

---

## 7. Observability

Structured logs (pino) carrying `requestId`, `organizationId`, `actorType`, route, status,
duration. Credentials are redacted at every level including trace.

`SENTRY_DSN` enables error reporting. Nothing is ever silently swallowed — an unrecognized error
is logged with its stack before a generic response goes out.

Watch:

- API p50/p95 latency (targets: <200 ms normal, <500 ms dashboard)
- Error rate by code — a spike in `tenant.*` or `auth.cross_tenant` is a security signal
- Location ingestion volume and the `trip_location_points` table size
- Database connection saturation
- Failed logins by identifier and by IP

---

## 8. Scheduled jobs

Not yet wired; the commands exist and need a scheduler.

| Job                           | Cadence | Command                      |
| ----------------------------- | ------- | ---------------------------- |
| Auto-close overrunning shifts | 15 min  | `autoCloseOverrunningShifts` |
| Detect tracking interruptions | 5 min   | `detectInterruptions`        |
| Prune expired sessions        | daily   | `pruneExpired`               |
| Prune auth attempts           | daily   | —                            |
| Location retention sweep      | daily   | `deleteOlderThan`            |
| Document expiry notifications | daily   | `pendingExpirations`         |

---

## 9. Production readiness

Before real customers (Phase 19):

- [ ] Security audit
- [ ] Tenant isolation verified in production configuration (app role, RLS active)
- [ ] Pricing security review
- [ ] Load test: 100 / 500 / 1000 workers, 100 active drivers, high GPS volume
- [ ] Backup **and restore** tested
- [ ] Migration tested against a production-sized copy
- [ ] E2E suite green
- [ ] Sentry configured and alerting
- [ ] Rate limits tuned against real traffic
- [ ] Redis added if a second replica is needed
