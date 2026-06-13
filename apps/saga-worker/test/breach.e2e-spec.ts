import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, appendEvent, TemporalHandle } from "@flashbite/shared";
import { EVENT_TYPES } from "@flashbite/contracts";
import { startSagaWorker, SagaWorkerHandle } from "../src/main";

describe("saga-worker SLA breach (e2e)", () => {
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

  it("no approval before the SLA -> refund + OrderCancelled(reason=SLA_BREACH)", async () => {
    const orderId = randomUUID();
    await appendEvent(prisma, { tenantId: "berlin", aggregateType: "ORDER", aggregateId: orderId, eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId } });

    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 2 }],
    });
    const result = await handle.result();
    expect(result).toBe("CANCELLED_SLA");

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["OrderPlaced", "OrderCancelled"]);
    const cancelled = events.find((e) => e.eventType === "OrderCancelled");
    expect((cancelled?.payload as { reason: string }).reason).toBe("SLA_BREACH");

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 30000);
});
