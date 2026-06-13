import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { appendEvent } from "@flashbite/shared";
import { EVENT_TYPES } from "@flashbite/contracts";
import { createActivities } from "../src/activities";

describe("saga activities", () => {
  const prisma = new PrismaClient();
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("recordOrderAccepted appends an OrderAccepted event at the next version", async () => {
    const orderId = randomUUID();
    await appendEvent(prisma, { tenantId: "berlin", aggregateType: "ORDER", aggregateId: orderId, eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId } }); // v1
    const activities = createActivities(prisma);
    await activities.recordOrderAcceptedActivity("berlin", orderId);

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["OrderPlaced", "OrderAccepted"]);
    expect(events[1].version).toBe(2);

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  });

  it("charge + refund activities resolve without throwing (fake gateway)", async () => {
    const activities = createActivities(prisma);
    await expect(activities.chargePaymentActivity("berlin", "o", 100)).resolves.toBeUndefined();
    await expect(activities.refundPaymentActivity("berlin", "o", 100)).resolves.toBeUndefined();
  });
});
