import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 6 stops loading `.env` once a config file exists ("Prisma config detected, skipping
 * environment variable loading"). Without this, every database command needs `DATABASE_URL=…`
 * typed in front of it, and the README's `pnpm db:migrate:deploy` does not work.
 *
 * Deliberately inlined rather than importing `loadRootEnvFiles` from `@aytracker/config`.
 * `prisma generate` is the *first* thing that runs on a fresh clone and in every CI job — before
 * anything is built — so this file cannot depend on a workspace package that resolves to `dist`.
 * Importing it broke all four CI jobs with "Cannot find module .../config/dist/index.js", and it
 * would break `pnpm setup` on a clone with no build output. Tooling that runs before the build
 * gets node builtins only.
 *
 * Anything already in the environment wins, so CI's injected DATABASE_URL and
 * `DATABASE_URL=… pnpm db:seed` against a scratch database both behave as before.
 */
function loadRootEnvFiles(): void {
  let root = process.cwd();
  for (;;) {
    if (existsSync(path.join(root, 'pnpm-workspace.yaml'))) break;
    const parent = path.dirname(root);
    if (parent === root) return;
    root = parent;
  }

  for (const candidate of ['.env.local', '.env']) {
    const file = path.join(root, candidate);
    if (!existsSync(file)) continue;
    // `loadEnvFile` overwrites, so what was already set is captured and restored.
    const before = { ...process.env };
    process.loadEnvFile(file);
    for (const [key, value] of Object.entries(before)) process.env[key] = value;
  }
}

loadRootEnvFiles();

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});
