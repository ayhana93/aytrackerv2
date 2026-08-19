# Railway deployment

See [docs/deployment.md](../../docs/deployment.md) for the full procedure. This directory holds
the service configuration.

## Services

| Service    | Config                                                           | Root            |
| ---------- | ---------------------------------------------------------------- | --------------- |
| `api`      | `api.json`                                                       | repository root |
| `web`      | `web.json`                                                       | repository root |
| `postgres` | Railway PostgreSQL 16 plugin                                     | —               |
| `redis`    | Railway Redis plugin — **only when a second API replica exists** | —               |

## First deploy

```bash
railway login
railway link                      # or: railway init

# 1. Provision PostgreSQL from the Railway dashboard.

# 2. Create the application role. Run once, as the owner:
railway connect postgres
```

```sql
CREATE ROLE aytracker_app LOGIN PASSWORD '<secret>';
GRANT CONNECT ON DATABASE railway TO aytracker_app;
GRANT USAGE ON SCHEMA public TO aytracker_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aytracker_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aytracker_app;
```

The application connects as `aytracker_app` so the RLS policies apply to it; migrations connect
as the owner. See [multi-tenancy.md](../../docs/multi-tenancy.md) § 2.

```bash
# 3. Set variables (see .env.example for the full list)
railway variables set SESSION_SECRET="$(openssl rand -base64 48)" --service api
railway variables set DATABASE_URL="postgresql://aytracker_app:...@.../railway" --service api
railway variables set APP_URL="https://app.aytracker.com" --service api
railway variables set API_URL="https://api.aytracker.com" --service api
railway variables set CORS_ALLOWED_ORIGINS="https://app.aytracker.com" --service api

# 4. Deploy
railway up --service api
railway up --service web

# 5. Seed platform reference data (markets, plans, prices, system roles).
#    SEED_DEMO=false keeps the demo organization out of production.
railway run --service api -- env SEED_DEMO=false pnpm db:seed
```

## Notes

- Migrations run at API start, before the server listens. Railway's health check gates the
  traffic switch, so a failed migration leaves the previous version serving.
- Health checks: `/health/ready` (api), `/` (web).
- `/health/live` deliberately does not touch the database — a liveness probe that fails on a slow
  query restarts a healthy container mid-incident.
- Schema changes are forward-only. To undo one, write a migration that reverses it; expand/contract
  means an application rollback never needs a schema rollback.
