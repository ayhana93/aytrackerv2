/**
 * Loading the developer's `.env.local` into `process.env`.
 *
 * Separate from `parseServerEnv`, and deliberately so: parsing and validating configuration is a
 * pure function of `process.env`, which is what lets it be tested without touching the filesystem
 * and what lets a production deploy supply its values however it likes. This module is only the
 * development convenience of getting a file into `process.env` first.
 *
 * It exists because without it the documented quick start does not work. `.env.example` says to
 * copy it to `.env.local`, but nothing read that file — so `pnpm dev` failed on a missing
 * SESSION_SECRET, and every database command needed `DATABASE_URL=…` typed in front of it. The
 * instructions were right about intent and wrong about outcome, which is the worst combination:
 * the reader assumes they made the mistake.
 *
 * Uses `process.loadEnvFile`, built into Node 22 — no dependency, and the same parser Node uses
 * for `--env-file`.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

/** Files tried in order. Later files never overwrite what earlier ones set. */
const CANDIDATES = ['.env.local', '.env'] as const;

export interface LoadEnvResult {
  readonly loaded: readonly string[];
}

/**
 * Loads root env files if they exist.
 *
 * **Never overrides a variable that is already set.** A value exported in the shell, injected by
 * CI, or supplied by the hosting platform must win over a file left in a working copy — otherwise
 * a stale `.env.local` silently points a production-ish command at a developer's database.
 *
 * `process.loadEnvFile` does overwrite, so existing values are captured and restored.
 */
export function loadRootEnvFiles(rootDir: string): LoadEnvResult {
  const loaded: string[] = [];
  const preexisting = { ...process.env };

  for (const candidate of CANDIDATES) {
    try {
      process.loadEnvFile(path.join(rootDir, candidate));
      loaded.push(candidate);
    } catch {
      // Missing is the normal case in production and in CI. Not an error.
      continue;
    }
  }

  for (const [key, value] of Object.entries(preexisting)) {
    if (value !== undefined) process.env[key] = value;
  }

  return { loaded };
}

/**
 * Walks up from `startDir` to find the workspace root.
 *
 * Every entry point that needs this sits at a different depth — `apps/api`, `apps/web`,
 * `packages/database` — and the env file belongs at the root, once, rather than copied into each.
 */
export function findWorkspaceRoot(startDir: string): string {
  let current = path.resolve(startDir);

  for (;;) {
    // The marker is the workspace file rather than package.json, which every package has.
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}
