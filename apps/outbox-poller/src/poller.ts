import type { Producer } from "kafkajs";
import type { PrismaService } from "@flashbite/shared";

/**
 * Publishes all PENDING outbox rows (oldest first) to Kafka and marks them SENT.
 * At-least-once: a row may publish more than once on crash between send and
 * update — consumers dedupe on the envelope eventId. Returns the number sent.
 */
export async function pollOnce(prisma: PrismaService, producer: Producer): Promise<number> {
  const pending = await prisma.outbox.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  for (const row of pending) {
    await producer.send({
      topic: row.topic,
      messages: [{ key: row.partitionKey, value: JSON.stringify(row.payload) }],
    });
    await prisma.outbox.update({ where: { id: row.id }, data: { status: "SENT" } });
  }

  return pending.length;
}
