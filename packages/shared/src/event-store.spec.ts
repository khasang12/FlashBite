import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { appendEvent } from "@flashbite/shared";
import { EVENT_TYPES } from "@flashbite/contracts";

describe("appendEvent", () => {
  const prisma = new PrismaClient();
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("appends an event at the next version with an outbox row (envelope payload)", async () => {
    const orderId = randomUUID();
    const v1 = await appendEvent(prisma, {
      tenantId: "berlin", aggregateType: "ORDER", aggregateId: orderId,
      eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId, customerId: "c", items: [], totalAmount: 1 },
    });
    expect(v1.version).toBe(1);

    const v2 = await appendEvent(prisma, {
      tenantId: "berlin", aggregateType: "ORDER", aggregateId: orderId,
      eventType: EVENT_TYPES.ORDER_ACCEPTED, payload: { orderId },
    });
    expect(v2.version).toBe(2);
    expect(v2.eventType).toBe("OrderAccepted");

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.version)).toEqual([1, 2]);

    const outbox = await prisma.outbox.findUnique({ where: { id: v2.eventId } });
    expect(outbox?.partitionKey).toBe(`berlin:${orderId}`);
    expect((outbox?.payload as { eventId: string }).eventId).toBe(v2.eventId);

    await prisma.outbox.deleteMany({ where: { tenantId: "berlin", partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { tenantId: "berlin", aggregateId: orderId } });
  });
});
