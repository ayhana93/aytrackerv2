import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { findWorkspaceRoot, loadRootEnvFiles } from '@aytracker/config';

/**
 * Prisma 6 stops loading `.env` once a config file exists ("Prisma config detected, skipping
 * environment variable loading"). Without this, every database command needed `DATABASE_URL=…`
 * typed in front of it, and the README's `pnpm db:migrate:deploy` simply did not work.
 *
 * Existing variables still win, so `DATABASE_URL=… pnpm db:seed` against a scratch database
 * behaves exactly as before.
 */
loadRootEnvFiles(findWorkspaceRoot(process.cwd()));

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});
