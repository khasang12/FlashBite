import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, RedisService, TemporalHandle } from "@flashbite/shared";
import { driverGeoKey, driverOnlineKey, dispatchAggregateId } from "@flashbite/contracts";

const BERLIN_CENTER = { lng: 13.405, lat: 52.52 };
import { startSagaWorker, SagaWorkerHandle } from "../../saga-worker/src/main";
import { driverDispatchWorkflow } from "../../saga-worker/src/dispatch-workflow";
import { AppModule } from "../src/app.module";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";

describe("write-api driver dispatch (e2e)", () => {
  let app: INestApplication;
  let saga: SagaWorkerHandle;
  let temporal: TemporalHandle;
  let auth: TestAuth;
  let driver: string;
  let customer: string;
  const prisma = new PrismaClient();
  const redis = new RedisService();

  beforeAll(async () => {
    await prisma.$connect();
    saga = await startSagaWorker();
    temporal = await connectTemporal();
    auth = await createTestAuth();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    driver = await auth.mint({ tenantId: "berlin", role: "driver", sub: "drv-1" });
    customer = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await saga?.stop();
    await temporal?.connection.close();
    await redis.cluster.quit();
    await prisma.$disconnect();
  });

  it("driver accept -> pickup -> deliver via HTTP signals -> workflow result DELIVERED", async () => {
    const driverId = `drv-${randomUUID().slice(0, 8)}`;
    const orderId = randomUUID();
    const c = BERLIN_CENTER;

    await redis.cluster.geoadd(driverGeoKey("berlin"), c.lng, c.lat, driverId);
    await redis.cluster.sadd(driverOnlineKey("berlin"), driverId);

    const handle = await temporal.client.workflow.start(driverDispatchWorkflow, {
      taskQueue: "order-lifecycle",
      workflowId: `dispatch:berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, offerTimeoutSeconds: 30, maxOffers: 5 }],
    });

    // Wait for workflow to reach its offer condition
    await new Promise((r) => setTimeout(r, 1500));

    await request(app.getHttpServer())
      .post(`/dispatch/${orderId}/accept`)
      .set("Authorization", `Bearer ${driver}`)
      .send({ driverId })
      .expect(202);

    await request(app.getHttpServer())
      .post(`/dispatch/${orderId}/pickup`)
      .set("Authorization", `Bearer ${driver}`)
      .send({ driverId })
      .expect(202);

    await request(app.getHttpServer())
      .post(`/dispatch/${orderId}/deliver`)
      .set("Authorization", `Bearer ${driver}`)
      .send({ driverId })
      .expect(202);

    const result = await handle.result();
    expect(result).toBe("DELIVERED");

    // Cleanup
    await handle.terminate().catch(() => undefined);
    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${dispatchAggregateId(orderId)}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: dispatchAggregateId(orderId) } });
    await redis.cluster.zrem(driverGeoKey("berlin"), driverId);
    await redis.cluster.srem(driverOnlineKey("berlin"), driverId);
  }, 60000);

  it("returns 403 when a non-driver role calls dispatch accept", async () => {
    const orderId = randomUUID();
    const res = await request(app.getHttpServer())
      .post(`/dispatch/${orderId}/accept`)
      .set("Authorization", `Bearer ${customer}`)
      .send({ driverId: "d-1" });
    expect(res.status).toBe(403);
  }, 60000);

  it("returns 404 when no active dispatch workflow exists for the orderId", async () => {
    const orderId = randomUUID();
    const res = await request(app.getHttpServer())
      .post(`/dispatch/${orderId}/accept`)
      .set("Authorization", `Bearer ${driver}`)
      .send({ driverId: "d-1" });
    expect(res.status).toBe(404);
  }, 60000);
});
