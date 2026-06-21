import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, appendWithExpectedVersion, TemporalHandle } from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES, ORDER_CANCEL_REASONS } from "@flashbite/contracts";
import { startSagaWorker, SagaWorkerHandle } from "../src/main";

describe("saga-worker payment-timeout (e2e: customer never confirms)", () => {
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

  it("no confirm within the window -> OrderCancelled(PAYMENT_TIMEOUT), no payment row", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, {
      tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
      expectedVersion: 0, eventType: EVENT_TYPES.ORDER_PLACED,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: 1200 },
    });

    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 60, confirmSeconds: 2 }],
    });
    const result = await handle.result(); // never signal confirm
    expect(result).toBe("CANCELLED_PAYMENT_TIMEOUT");

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["OrderPlaced", "OrderCancelled"]);
    expect((events[1].payload as { reason: string }).reason).toBe(ORDER_CANCEL_REASONS.PAYMENT_TIMEOUT);

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);
});
