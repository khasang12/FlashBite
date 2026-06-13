import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, appendEvent, TemporalHandle } from "@flashbite/shared";
import { startSagaWorker, SagaWorkerHandle } from "../../saga-worker/src/main";
import { AppModule } from "../src/app.module";

describe("write-api merchant accept (e2e)", () => {
  let app: INestApplication;
  let saga: SagaWorkerHandle;
  let temporal: TemporalHandle;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.$connect();
    saga = await startSagaWorker();
    temporal = await connectTemporal();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await saga?.stop();
    await temporal?.connection.close();
    await prisma.$disconnect();
  });

  it("POST /orders/:id/accept signals the workflow -> ACCEPTED + OrderAccepted event", async () => {
    const orderId = randomUUID();
    await appendEvent(prisma, { tenantId: "berlin", aggregateType: "ORDER", aggregateId: orderId, eventType: "OrderPlaced", payload: { orderId } });
    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 60 }],
    });

    const res = await request(app.getHttpServer()).post(`/orders/${orderId}/accept`).set("X-Tenant-ID", "berlin");
    expect(res.status).toBe(202);

    const result = await handle.result();
    expect(result).toBe("ACCEPTED");

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);
});
