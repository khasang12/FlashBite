import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { AppModule } from "../src/app.module";
import { TOPICS, type EventEnvelope, type DriverTelemetryPayload } from "@flashbite/contracts";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";
import { createRegistry, readEnvelope } from "@flashbite/messaging";

describe("read-api telemetry ingest (e2e)", () => {
  let app: INestApplication;
  let auth: TestAuth;
  let berlinToken: string;
  const kafka = new Kafka({ clientId: "ingest-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });

  beforeAll(async () => {
    auth = await createTestAuth();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    berlinToken = await auth.mint({ tenantId: "berlin", role: "driver", sub: "d-1" });
  }, 30000);
  afterAll(async () => {
    await app.close();
  });

  it("POST /drivers/:id/location publishes a DriverTelemetryStreamed envelope to telemetry-streams", async () => {
    const driverId = `d-${randomUUID()}`;
    const registry = createRegistry(process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081");

    const admin = kafka.admin();
    await admin.connect();
    const before = await admin.fetchTopicOffsets(TOPICS.TELEMETRY_STREAMS);
    await admin.disconnect();
    const startOffsets = new Map(before.map((w) => [w.partition, BigInt(w.high)]));

    const res = await request(app.getHttpServer())
      .post(`/drivers/${driverId}/location`)
      .set("Authorization", `Bearer ${berlinToken}`)
      .send({ lng: 13.405, lat: 52.52 });
    expect(res.status).toBe(202);

    const consumer = kafka.consumer({ groupId: `ingest-test-${Date.now()}` });
    let got: EventEnvelope;
    try {
      await consumer.connect();
      await consumer.subscribe({ topic: TOPICS.TELEMETRY_STREAMS, fromBeginning: true });
      got = await new Promise<EventEnvelope>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no telemetry message")), 10000);
        consumer.on(consumer.events.GROUP_JOIN, () => {
          for (const [p, o] of startOffsets) consumer.seek({ topic: TOPICS.TELEMETRY_STREAMS, partition: p, offset: o.toString() });
        });
        consumer.run({
          eachMessage: async ({ partition, message }) => {
            if (BigInt(message.offset) < (startOffsets.get(partition) ?? 0n)) return;
            const env = await readEnvelope(registry, message);
            if (!env) return;
            if ((env.payload as DriverTelemetryPayload).driverId === driverId) {
              clearTimeout(timer);
              resolve(env);
            }
          },
        }).catch(reject);
      });
    } finally {
      await consumer.disconnect();
    }

    expect(got!.eventType).toBe("DriverTelemetryStreamed");
    expect(got!.tenantId).toBe("berlin");
    expect((got!.payload as DriverTelemetryPayload).lat).toBe(52.52);
  }, 30000);
});
