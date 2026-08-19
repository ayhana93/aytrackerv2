import { Prisma, PrismaClient } from '@prisma/client';

export type { Prisma };
export { PrismaClient };

/** The transaction-scoped client type. Repositories accept this so they compose in a tx. */
export type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export type DatabaseClient = PrismaClient | PrismaTransactionClient;

let singleton: PrismaClient | undefined;

export interface CreateClientOptions {
  readonly databaseUrl?: string;
  readonly logQueries?: boolean;
}

/**
 * Process-wide Prisma client.
 *
 * Reused because each client owns its own connection pool, and Railway's Postgres plans have a
 * connection budget that a per-request client would exhaust immediately.
 */
export function getPrismaClient(options: CreateClientOptions = {}): PrismaClient {
  if (!singleton) {
    singleton = new PrismaClient({
      ...(options.databaseUrl ? { datasources: { db: { url: options.databaseUrl } } } : {}),
      log: options.logQueries
        ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
        : ['warn', 'error'],
    });
  }
  return singleton;
}

export async function disconnectPrisma(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect();
    singleton = undefined;
  }
}

/**
 * Runs `fn` inside a transaction with the tenant GUC set, so the RLS policies from the
 * `invariants_and_rls` migration apply.
 *
 * `SET LOCAL` scopes the setting to the transaction, so a pooled connection cannot leak one
 * request's tenant into the next — which is exactly the failure mode that would make RLS
 * worse than no RLS.
 *
 * Note the honest limitation: RLS does not constrain the migration/owner role. In production
 * the application connects as a non-owner role and these policies bite; in local development
 * against the owner they are inert. That is why the application-layer tenant filter is the
 * primary control and this is defense in depth — see docs/multi-tenancy.md.
 */
export async function withTenant<T>(
  client: PrismaClient,
  organizationId: string,
  fn: (tx: PrismaTransactionClient) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  return client.$transaction(
    async (tx) => {
      // Parameterized: set_config is a function call, so the tenant id can never be
      // concatenated into SQL text.
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
      return fn(tx);
    },
    { timeout: options?.timeoutMs ?? 15_000 },
  );
}

/** A transaction without a tenant GUC — for platform-level work (markets, plans, signup). */
export async function withTransaction<T>(
  client: PrismaClient,
  fn: (tx: PrismaTransactionClient) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  return client.$transaction(fn, { timeout: options?.timeoutMs ?? 15_000 });
}

/**
 * Recognizes the database-level invariant violations from the constraints migration so the
 * application can translate them into a meaningful domain error rather than a 500.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  if (!constraint) return true;
  const target = error.meta?.['target'];
  const targetText = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return targetText.includes(constraint) || (error.message ?? '').includes(constraint);
}

export function isCheckViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2010' || error.code === 'P2000') === false &&
    typeof error.message === 'string' &&
    error.message.includes('violates check constraint')
  );
}

export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/**
 * Raw-SQL constraint-name extraction, used to map a partial unique index violation onto the
 * business rule it enforces (e.g. `position_sessions_one_open_per_shift` → "you already have an
 * open position session").
 */
export function violatedConstraintName(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const match = /constraint "([^"]+)"|index "([^"]+)"/.exec(error.message ?? '');
  return match?.[1] ?? match?.[2] ?? null;
}
