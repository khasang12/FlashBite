import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { appendWithExpectedVersion } from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES } from "@flashbite/contracts";
import { createActivities } from "../src/activities";

const appUrl = (() => {
  const u = new URL(process.env.DATABASE_URL ?? "postgresql://flashbite@localhost:5434/flashbite_write");
  u.username = "flashbite_app";
  u.password = "flashbite_app_local_dev";
  return u.toString();
})();

describe("saga aggregate race-safety (e2e)", () => {
  const prisma = new PrismaClient({ datasourceUrl: appUrl });
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("recordOrderAccepted is a no-op when the order already CANCELLED (SLA race loser)", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, {
      tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
      expectedVersion: 0, eventType: EVENT_TYPES.ORDER_PLACED,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: 1000 },
    });
    await appendWithExpectedVersion(prisma, {
      tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
      expectedVersion: 1, eventType: EVENT_TYPES.ORDER_CANCELLED,
      payload: { orderId, reason: "SLA_BREACH" },
    });

    await createActivities(prisma).recordOrderAcceptedActivity("berlin", orderId); // must NOT throw, must NOT append

    const owner = new PrismaClient(); // superuser, bypasses RLS, sees all rows
    await owner.$connect();
    const rows = await owner.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    await owner.$disconnect();
    expect(rows).toHaveLength(2); // PLACED + CANCELLED only — no OrderAccepted
    expect(rows[1].eventType).toBe(EVENT_TYPES.ORDER_CANCELLED);
  });
});
