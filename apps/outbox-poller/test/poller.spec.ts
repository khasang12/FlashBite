import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { PrismaService, buildEnvelope } from "@flashbite/shared";
import { EVENT_TYPES, TOPICS } from "@flashbite/contracts";
import { createRegistry, registerAllSchemas, decodePayload, parseHeaders } from "@flashbite/messaging";
import { pollOnce } from "../src/poller";

const HOST = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";

describe("outbox poller (Avro)", () => {
  const prisma = new PrismaService();
  const kafka = new Kafka({ clientId: "poller-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });
  const registry = createRegistry(HOST);

  beforeAll(async () => {
    await prisma.$connect();
    await registerAllSchemas(registry, HOST);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("publishes PENDING rows as Avro (payload value + headers) and marks them SENT", async () => {
    const orderId = randomUUID();
    const eventId = randomUUID();
    const envelope = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 1,
      eventId,
      payload: { orderId, customerId: "c-1", items: [{ sku: "x", qty: 1, price: 2.5 }], totalAmount: 2.5 },
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
    let count: number;
    try {
      count = await pollOnce(prisma, producer, registry);
    } finally {
      await producer.disconnect();
    }
    expect(count).toBeGreaterThanOrEqual(1);

    const row = await prisma.outbox.findUnique({ where: { id: eventId } });
    expect(row?.status).toBe("SENT");

    const consumer = kafka.consumer({ groupId: `poller-test-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: true });
    const received: { eventId: string; orderId: string; sku: string } = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("event not received")), 10000);
      consumer.on(consumer.events.GROUP_JOIN, () => {
        for (const [p, o] of startOffsets) consumer.seek({ topic: TOPICS.ORDER_EVENTS, partition: p, offset: o.toString() });
      });
      consumer
        .run({
          eachMessage: async ({ partition, message }) => {
            if (BigInt(message.offset) < (startOffsets.get(partition) ?? 0n)) return;
            const meta = parseHeaders(message.headers);
            if (meta.eventId !== eventId) return;
            const payload = await decodePayload<{ orderId: string; items: { sku: string }[] }>(registry, message.value!);
            clearTimeout(timer);
            resolve({ eventId: meta.eventId, orderId: payload.orderId, sku: payload.items[0].sku });
          },
        })
        .catch(reject);
    });
    await consumer.disconnect();
    expect(received.eventId).toBe(eventId);
    expect(received.orderId).toBe(orderId);
    expect(received.sku).toBe("x");

    await prisma.outbox.delete({ where: { id: eventId } });
  });
});
