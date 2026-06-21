import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { appendWithExpectedVersion } from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES } from "@flashbite/contracts";
import { createActivities } from "../src/activities";

describe("saga activities", () => {
  const prisma = new PrismaClient();
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("recordOrderAccepted appends an OrderAccepted event at the next version", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, { tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId, expectedVersion: 0, eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId, customerId: "c-1", items: [], totalAmount: 1000 } }); // v1
    const activities = createActivities(prisma);
    await activities.recordOrderAcceptedActivity("berlin", orderId);

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["OrderPlaced", "OrderAccepted"]);
    expect(events[1].version).toBe(2);

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  });

});
