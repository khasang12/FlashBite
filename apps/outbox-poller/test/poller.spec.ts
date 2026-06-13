import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { PrismaService } from "@flashbite/shared";
import { buildEnvelope, EVENT_TYPES, TOPICS } from "@flashbite/contracts";
import { pollOnce } from "../src/poller";

describe("outbox poller", () => {
  const prisma = new PrismaService();
  const kafka = new Kafka({ clientId: "poller-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("publishes PENDING rows and marks them SENT", async () => {
    const orderId = randomUUID();
    const eventId = randomUUID();
    const envelope = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 1,
      eventId,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: 0 },
    });
    await prisma.outbox.create({
      data: {
        id: eventId,
        tenantId: "berlin",
        topic: TOPICS.ORDER_EVENTS,
        partitionKey: `berlin:${orderId}`,
        eventType: EVENT_TYPES.ORDER_PLACED,
        payload: envelope as never,
      },
    });

    const admin = kafka.admin();
    await admin.connect();
    const before = await admin.fetchTopicOffsets(TOPICS.ORDER_EVENTS);
    await admin.disconnect();
    const startOffsets = new Map(before.map((w) => [w.partition, BigInt(w.high)]));

    const producer = kafka.producer();
    await producer.connect();
    const count = await pollOnce(prisma, producer);
    await producer.disconnect();
    expect(count).toBeGreaterThanOrEqual(1);

    const row = await prisma.outbox.findUnique({ where: { id: eventId } });
    expect(row?.status).toBe("SENT");

    const consumer = kafka.consumer({ groupId: `poller-test-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: true });
    const received: string = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("event not received")), 10000);
      consumer.on(consumer.events.GROUP_JOIN, () => {
        for (const [p, o] of startOffsets) consumer.seek({ topic: TOPICS.ORDER_EVENTS, partition: p, offset: o.toString() });
      });
      consumer
        .run({
          eachMessage: async ({ partition, message }) => {
            if (BigInt(message.offset) < (startOffsets.get(partition) ?? 0n)) return;
            const value = JSON.parse(message.value!.toString());
            if (value.eventId === eventId) {
              clearTimeout(timer);
              resolve(value.eventId);
            }
          },
        })
        .catch(reject);
    });
    await consumer.disconnect();
    expect(received).toBe(eventId);

    await prisma.outbox.delete({ where: { id: eventId } });
  });
});
