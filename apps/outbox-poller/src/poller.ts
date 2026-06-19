import type { Producer } from "kafkajs";
import type { PrismaService } from "@flashbite/shared";
import type { EventEnvelope } from "@flashbite/contracts";
import { publishEnvelope, type SchemaRegistry } from "@flashbite/messaging";

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
    await publishEnvelope(producer, registry, row.topic, row.partitionKey, row.payload as unknown as EventEnvelope);
    await prisma.outbox.update({ where: { id: row.id }, data: { status: "SENT" } });
  }

  return pending.length;
}
