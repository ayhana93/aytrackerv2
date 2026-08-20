/**
 * @aytracker/config — environment parsing and derived application settings.
 *
 * Never import this from the web app: it would drag server-only secrets into the browser bundle.
 * The web app reads its own NEXT_PUBLIC_* variables.
 */

export * from './env.js';
export * from './load-env-file.js';
