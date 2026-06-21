import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, appendWithExpectedVersion, TemporalHandle } from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES } from "@flashbite/contracts";
import { merchantApprovalSignal, confirmPaymentSignal } from "../src/workflows";
import { startSagaWorker, SagaWorkerHandle } from "../src/main";

describe("saga-worker (e2e: live Temporal + Postgres)", () => {
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

  it("approved order writes an OrderAccepted event (v2) to the store/outbox", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, {
      tenantId: "berlin",
      aggregateType: AGGREGATE_TYPES.ORDER,
      aggregateId: orderId,
      expectedVersion: 0,
      eventType: EVENT_TYPES.ORDER_PLACED,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: 1200 },
    });

    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 60, confirmSeconds: 60, offerTimeoutSeconds: 2, maxOffers: 1, deliverySeconds: 300 }],
    });
    await handle.signal(confirmPaymentSignal);
    await handle.signal(merchantApprovalSignal, true);
    const result = await handle.result();
    // After accept the parent runs the dispatch child; with no seeded driver the child fails fast
    // and the parent maps it to DISPATCH_FAILED. The order aggregate still records OrderAccepted.
    expect(result).toBe("DISPATCH_FAILED");

    const events = await prisma.eventStore.findMany({
      where: { tenantId: "berlin", aggregateId: orderId },
      orderBy: { version: "asc" },
    });
    expect(events.map((e) => e.eventType)).toEqual(["OrderPlaced", "OrderAccepted"]);

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);
});
