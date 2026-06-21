import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { connectTemporal, buildEnvelope, type TemporalHandle } from "@flashbite/shared";
import { CONSUMER_GROUPS, EVENT_TYPES, TOPICS, type OrderPlacedPayload } from "@flashbite/contracts";
import { createRegistry, registerAllSchemas, publishEnvelope, type SchemaRegistry } from "@flashbite/messaging";
import { startOrderConsumer, SagaWorkerHandle } from "../src/main";

const SR_HOST = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";

describe("saga-worker Kafka consumer (Avro integration)", () => {
  const kafka = new Kafka({ clientId: "saga-consumer-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });
  const registry: SchemaRegistry = createRegistry(SR_HOST);
  let temporal: TemporalHandle;
  let handle: SagaWorkerHandle;

  beforeAll(async () => {
    await registerAllSchemas(registry, SR_HOST);
    temporal = await connectTemporal();
  }, 60000);

  afterAll(async () => {
    await handle?.stop();
    await temporal?.connection.close();
  });

  it("consumes an Avro OrderPlaced envelope and starts a Temporal workflow", async () => {
    const orderId = randomUUID();
    const tenantId = "berlin";
    const payload: OrderPlacedPayload = { orderId, customerId: "c-test", items: [], totalAmount: 750 };
    const envelope = buildEnvelope({ tenantId, eventType: EVENT_TYPES.ORDER_PLACED, version: 1, payload });

    const consumer = kafka.consumer({ groupId: `${CONSUMER_GROUPS.SAGA}-test-${Date.now()}` });
    handle = await startOrderConsumer(consumer, temporal, 300, 120, registry);

    const producer = kafka.producer();
    await producer.connect();
    await publishEnvelope(producer, registry, TOPICS.ORDER_EVENTS, `${tenantId}:${orderId}`, envelope);
    await producer.disconnect();

    // Poll until Temporal workflow exists (started by the consumer)
    let wfHandle = null;
    for (let i = 0; i < 50 && !wfHandle; i++) {
      try {
        const h = temporal.client.workflow.getHandle(`${tenantId}:${orderId}`);
        await h.describe();
        wfHandle = h;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    expect(wfHandle).not.toBeNull();

    // Terminate the workflow to avoid it running beyond the test
    await wfHandle!.terminate("test cleanup");
  }, 30000);
});
