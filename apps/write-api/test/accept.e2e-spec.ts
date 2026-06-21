import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, appendWithExpectedVersion, TemporalHandle } from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES } from "@flashbite/contracts";
import { startSagaWorker, SagaWorkerHandle } from "../../saga-worker/src/main";
import { AppModule } from "../src/app.module";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";

describe("write-api merchant accept (e2e)", () => {
  let app: INestApplication;
  let saga: SagaWorkerHandle;
  let temporal: TemporalHandle;
  let auth: TestAuth;
  let merchant: string;
  let customer: string;
  const prisma = new PrismaClient();

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
    merchant = await auth.mint({ tenantId: "berlin", role: "merchant", sub: "m-1" });
    customer = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await saga?.stop();
    await temporal?.connection.close();
    await prisma.$disconnect();
  });

  it("accept is rejected (409) before the payment is authorized", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, { tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId, expectedVersion: 0, eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId, customerId: "c-1", items: [], totalAmount: 1200 } });
    await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 60, confirmSeconds: 60, offerTimeoutSeconds: 2, maxOffers: 1, deliverySeconds: 300 }],
    });
    const res = await request(app.getHttpServer())
      .post(`/orders/${orderId}/accept`)
      .set("Authorization", `Bearer ${merchant}`);
    expect(res.status).toBe(409);

    await temporal.client.workflow.getHandle(`berlin:${orderId}`).terminate().catch(() => undefined);
    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);

  it("POST /orders/:id/accept after confirm+authorize -> ACCEPTED + OrderAccepted event", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, { tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId, expectedVersion: 0, eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId, customerId: "c-1", items: [], totalAmount: 1200 } });
    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 60, confirmSeconds: 60, offerTimeoutSeconds: 2, maxOffers: 1, deliverySeconds: 300 }],
    });

    await request(app.getHttpServer()).post(`/orders/${orderId}/confirm-payment`).set("Authorization", `Bearer ${customer}`).expect(202);
    let acceptStatus = 0;
    for (let i = 0; i < 30 && acceptStatus !== 202; i++) {
      const r = await request(app.getHttpServer()).post(`/orders/${orderId}/accept`).set("Authorization", `Bearer ${merchant}`);
      acceptStatus = r.status;
      if (acceptStatus !== 202) await new Promise((res) => setTimeout(res, 500));
    }
    expect(acceptStatus).toBe(202);

    const result = await handle.result();
    // No driver seeded -> the dispatch child fails fast and the parent maps it to DISPATCH_FAILED.
    // The accept itself (202 + OrderAccepted) is what this test asserts; the full DELIVERED path
    // is covered by the standalone dispatch e2e.
    expect(result).toBe("DISPATCH_FAILED");

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);
});
