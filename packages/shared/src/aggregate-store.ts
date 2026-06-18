import { PrismaClient, Prisma } from "@prisma/client";
import { TOPICS, type EventEnvelope } from "@flashbite/contracts";
import { buildEnvelope } from "./envelope";
import { withTenantTransaction } from "./tenant-transaction";

export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}

export interface LoadedAggregate<S> {
  state: S;
  version: number;
}

/** Replays the aggregate's event stream (tenant-scoped, under the RLS GUC) and folds it. */
export async function loadAggregate<S>(
  prisma: PrismaClient,
  args: { tenantId: string; aggregateId: string },
  fold: (state: S, event: { eventType: string; payload: unknown; version: number }) => S,
  initial: S,
): Promise<LoadedAggregate<S>> {
  return withTenantTransaction(prisma, args.tenantId, async (tx) => {
    const rows = await tx.eventStore.findMany({
      where: { tenantId: args.tenantId, aggregateId: args.aggregateId },
      orderBy: { version: "asc" },
    });
    let state = initial;
    let version = 0;
    for (const r of rows) {
      state = fold(state, { eventType: r.eventType, payload: r.payload as unknown, version: r.version });
      version = r.version;
    }
    return { state, version };
  });
}

export interface AppendArgs {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  expectedVersion: number;
  eventType: string;
  payload: unknown;
}

/**
 * Appends one event at version = expectedVersion + 1, atomically with the outbox row,
 * under the RLS GUC. A unique-constraint (P2002) collision on (tenantId, aggregateId,
 * version) — a concurrent writer already took this version — becomes ConcurrencyError.
 */
export async function appendWithExpectedVersion(prisma: PrismaClient, args: AppendArgs): Promise<EventEnvelope> {
  const version = args.expectedVersion + 1;
  const envelope = buildEnvelope({ tenantId: args.tenantId, eventType: args.eventType, version, payload: args.payload });
  try {
    return await withTenantTransaction(prisma, args.tenantId, async (tx) => {
      await tx.eventStore.create({
        data: {
          id: envelope.eventId,
          tenantId: args.tenantId,
          aggregateType: args.aggregateType,
          aggregateId: args.aggregateId,
          version,
          eventType: args.eventType,
          payload: args.payload as Prisma.InputJsonValue,
        },
      });
      await tx.outbox.create({
        data: {
          id: envelope.eventId,
          tenantId: args.tenantId,
          topic: TOPICS.ORDER_EVENTS,
          partitionKey: `${args.tenantId}:${args.aggregateId}`,
          eventType: args.eventType,
          payload: envelope as unknown as Prisma.InputJsonValue,
        },
      });
      return envelope;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ConcurrencyError(`version conflict on ${args.aggregateId} at version ${version}`);
    }
    throw err;
  }
}
