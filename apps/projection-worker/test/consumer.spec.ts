import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { connectMongo, MongoHandle, buildEnvelope } from "@flashbite/shared";
import {
  EVENT_TYPES,
  READ_COLLECTIONS,
  TOPICS,
  type OrderPlacedPayload,
} from "@flashbite/contracts";
import { createRegistry, registerAllSchemas, publishEnvelope, type SchemaRegistry } from "@flashbite/messaging";
import { runConsumer } from "../src/main";

const SR_HOST = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";

describe("projection-worker consumer (integration)", () => {
  let mongo: MongoHandle;
  const kafka = new Kafka({ clientId: "proj-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });
  const registry: SchemaRegistry = createRegistry(SR_HOST);

  beforeAll(async () => {
    mongo = await connectMongo();
    await registerAllSchemas(registry, SR_HOST);
  });
  afterAll(async () => {
    await mongo.client.close();
  });

  it("consumes an OrderPlaced envelope and projects it into Mongo", async () => {
    const orderId = randomUUID();
    const payload: OrderPlacedPayload = { orderId, customerId: "c-1", items: [], totalAmount: 500 };
    const envelope = buildEnvelope({ tenantId: "berlin", eventType: EVENT_TYPES.ORDER_PLACED, version: 1, payload });

    const consumer = kafka.consumer({ groupId: `projection-worker-test-${Date.now()}` });
    const handle = await runConsumer(consumer, mongo.db, registry);

    const producer = kafka.producer();
    await producer.connect();
    await publishEnvelope(producer, registry, TOPICS.ORDER_EVENTS, `berlin:${orderId}`, envelope);
    await producer.disconnect();

    let doc = null;
    for (let i = 0; i < 50 && !doc; i++) {
      doc = await mongo.db.collection(READ_COLLECTIONS.ORDERS).findOne({ _id: `berlin:${orderId}` as never });
      if (!doc) await new Promise((r) => setTimeout(r, 200));
    }
    expect(doc).toMatchObject({ orderId, status: "PLACED", totalAmount: 500 });

    await handle.stop();
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` as never });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteOne({ _id: `berlin:projection-worker:${envelope.eventId}` as never });
  }, 30000);
});
