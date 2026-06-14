import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { createRedisCluster, buildEnvelope } from "@flashbite/shared";
import { EVENT_TYPES, TOPICS, driverGeoKey, type DriverTelemetryPayload } from "@flashbite/contracts";
import { runTelemetryConsumer } from "../src/main";

describe("telemetry-worker consumer (integration)", () => {
  const cluster = createRedisCluster();
  const kafka = new Kafka({ clientId: "telemetry-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });

  afterAll(async () => {
    await cluster.quit();
  });

  it("consumes a telemetry envelope and GEOADDs the driver", async () => {
    const driverId = `d-${randomUUID()}`;
    const envelope = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED,
      version: 1,
      payload: { driverId, lng: 13.405, lat: 52.52 } as DriverTelemetryPayload,
    });

    const consumer = kafka.consumer({ groupId: `telemetry-worker-test-${Date.now()}` });
    const handle = await runTelemetryConsumer(consumer, cluster);

    try {
      const producer = kafka.producer();
      await producer.connect();
      await producer.send({
        topic: TOPICS.TELEMETRY_STREAMS,
        messages: [{ key: `berlin:${driverId}`, value: JSON.stringify(envelope) }],
      });
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
