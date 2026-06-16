import { PrismaClient, Prisma } from "@prisma/client";

/**
 * Opens an interactive transaction with the per-request tenant GUC set as the FIRST
 * statement, so Postgres Row-Level Security on event_store/outbox admits the writes.
 * ALL tenant-scoped writes to the event store MUST go through this helper rather than
 * calling prisma.$transaction directly — that's what guarantees the RLS context is set.
 *
 * set_config(..., true) is transaction-local (auto-resets at commit/rollback) and the
 * tenantId is passed as a bound parameter (no SQL injection).
 */
export async function withTenantTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
