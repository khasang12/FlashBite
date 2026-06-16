import { PrismaClient, Prisma } from "@prisma/client";
import { TOPICS, type EventEnvelope } from "@flashbite/contracts";
import { buildEnvelope } from "./envelope";
import { withTenantTransaction } from "./tenant-transaction";

export interface AppendEventArgs {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

/**
 * Appends a domain event to the event store + outbox atomically, at the next
 * version for the aggregate. event_store.payload = domain payload; outbox.payload
 * = the full envelope (so the poller publishes the envelope). Returns the envelope.
 */
export async function appendEvent(prisma: PrismaClient, args: AppendEventArgs): Promise<EventEnvelope> {
  return withTenantTransaction(prisma, args.tenantId, async (tx) => {
    const last = await tx.eventStore.findFirst({
      where: { tenantId: args.tenantId, aggregateId: args.aggregateId },
      orderBy: { version: "desc" },
    });
    const version = (last?.version ?? 0) + 1;
    const envelope = buildEnvelope({
      tenantId: args.tenantId,
      eventType: args.eventType,
      version,
      payload: args.payload,
    });
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
}
