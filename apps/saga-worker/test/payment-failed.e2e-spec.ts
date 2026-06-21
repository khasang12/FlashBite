import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, appendWithExpectedVersion, TemporalHandle } from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES, ORDER_CANCEL_REASONS } from "@flashbite/contracts";
import { confirmPaymentSignal } from "../src/workflows";
import { startSagaWorker, SagaWorkerHandle } from "../src/main";

describe("saga-worker payment-failed (e2e: declined authorize)", () => {
  const prisma = new PrismaClient();
  let temporal: TemporalHandle;
  let saga: SagaWorkerHandle;

  beforeAll(async () => {
    await prisma.$connect();
    temporal = await connectTemporal();
    saga = await startSagaWorker();
  }, 60000);
  afterAll(async () => {
    await saga?.stop();
    await temporal?.connection.close();
    await prisma.$disconnect();
  });

  it("a declining amount cancels the order with PAYMENT_FAILED and never accepts", async () => {
    const orderId = randomUUID();
    const declineAmount = 100000; // >= AUTH_DECLINE_THRESHOLD
    await appendWithExpectedVersion(prisma, {
      tenantId: "berlin",
      aggregateType: AGGREGATE_TYPES.ORDER,
      aggregateId: orderId,
      expectedVersion: 0,
      eventType: EVENT_TYPES.ORDER_PLACED,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: declineAmount },
    });

    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: declineAmount, slaSeconds: 60, confirmSeconds: 60 }],
    });
    await handle.signal(confirmPaymentSignal);
    const result = await handle.result();
    expect(result).toBe("CANCELLED_PAYMENT_FAILED");

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["OrderPlaced", "OrderCancelled"]);
    const cancelled = events[1].payload as { reason: string };
    expect(cancelled.reason).toBe(ORDER_CANCEL_REASONS.PAYMENT_FAILED);

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);
});
