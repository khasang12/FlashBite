import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { createRedisCluster, buildEnvelope } from "@flashbite/shared";
import { EVENT_TYPES, TOPICS, driverGeoKey, type DriverTelemetryPayload } from "@flashbite/contracts";
import { createRegistry, registerAllSchemas, publishEnvelope, type SchemaRegistry } from "@flashbite/messaging";
import { runTelemetryConsumer } from "../src/main";

const SR_HOST = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";

describe("telemetry-worker consumer (integration)", () => {
  const cluster = createRedisCluster();
  const kafka = new Kafka({ clientId: "telemetry-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });
  let registry: SchemaRegistry;

  beforeAll(async () => {
    registry = createRegistry(SR_HOST);
    await registerAllSchemas(registry, SR_HOST);
  });

  afterAll(async () => {
    await cluster.quit();
  });

  it("consumes a telemetry envelope and GEOADDs the driver", async () => {
    const driverId = `d-${randomUUID()}`;
    const envelope = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED,
      version: 1,
      payload: { driverId, lng: 13.405, lat: 52.52, orderId: null } as unknown as DriverTelemetryPayload,
    });

    const consumer = kafka.consumer({ groupId: `telemetry-worker-test-${Date.now()}` });
    const handle = await runTelemetryConsumer(consumer, cluster, registry);

    try {
      const producer = kafka.producer();
      await producer.connect();
      await publishEnvelope(producer, registry, TOPICS.TELEMETRY_STREAMS, `berlin:${driverId}`, envelope);
      await producer.disconnect();

      let pos: Array<[string, string] | null> = [null];
      for (let i = 0; i < 50 && !pos[0]; i++) {
        pos = (await cluster.geopos(driverGeoKey("berlin"), driverId)) as Array<[string, string] | null>;
        if (!pos[0]) await new Promise((r) => setTimeout(r, 200));
      }
      expect(pos[0]).not.toBeNull();

      await cluster.zrem(driverGeoKey("berlin"), driverId);
    } finally {
      await handle.stop();
    }
  }, 30000);
});
