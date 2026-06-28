import type { Producer } from "kafkajs";
import type { PrismaService } from "@flashbite/shared";
import type { EventEnvelope } from "@flashbite/contracts";
import { publishEnvelope, type SchemaRegistry } from "@flashbite/messaging";
import { runWithObsContext, createLogger, newCorrelationId } from "@flashbite/shared";

const log = createLogger("outbox-poller");

/**
 * Publishes all PENDING outbox rows (oldest first) to Kafka as Confluent-Avro
 * (payload value + metadata headers) and marks them SENT. At-least-once: a row
 * may publish more than once on crash between send and update — consumers dedupe
 * on the envelope eventId. Returns the number sent.
 */
export async function pollOnce(prisma: PrismaService, producer: Producer, registry: SchemaRegistry): Promise<number> {
  const pending = await prisma.outbox.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  for (const row of pending) {
    const env = row.payload as unknown as EventEnvelope;
    await runWithObsContext(
      { correlationId: env.correlationId ?? newCorrelationId(), tenantId: env.tenantId, eventId: env.eventId },
      async () => {
        await publishEnvelope(producer, registry, row.topic, row.partitionKey, env);
        log.info({ topic: row.topic, eventType: env.eventType }, "published");
      },
    );
    await prisma.outbox.update({ where: { id: row.id }, data: { status: "SENT" } });
  }

  return pending.length;
}
