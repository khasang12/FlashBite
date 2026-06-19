import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma, connectMongo, MongoHandle } from "@flashbite/shared";
import {
  READ_COLLECTIONS,
  EVENT_TYPES,
  AGGREGATE_TYPES,
} from "@flashbite/contracts";
import { rebuildProjection } from "../src/rebuild";

describe("rebuildProjection (e2e)", () => {
  const prisma = new PrismaClient(); // DATABASE_URL (superuser) — cross-tenant, bypasses RLS
  let mongo: MongoHandle;
  const orderId = randomUUID();
  const eventId1 = randomUUID();
  const eventId2 = randomUUID();
  const customerId = "c-rebuild-test";
  const totalAmount = 2500;

  beforeAll(async () => {
    await prisma.$connect();
    mongo = await connectMongo();

    // Seed two event_store rows for the same order aggregate
    await prisma.eventStore.create({
      data: {
        id: eventId1,
        tenantId: "berlin",
        aggregateType: AGGREGATE_TYPES.ORDER,
        aggregateId: orderId,
        version: 1,
        eventType: EVENT_TYPES.ORDER_PLACED,
        payload: {
          orderId,
          customerId,
          items: [{ sku: "burger", qty: 2, price: 1250 }],
          totalAmount,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.eventStore.create({
      data: {
        id: eventId2,
        tenantId: "berlin",
        aggregateType: AGGREGATE_TYPES.ORDER,
        aggregateId: orderId,
        version: 2,
        eventType: EVENT_TYPES.ORDER_ACCEPTED,
        payload: { orderId } as unknown as Prisma.InputJsonValue,
      },
    });
  }, 30000);

  afterAll(async () => {
    // Clean up seeded event_store rows so they don't leak into other tests
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
    await prisma.$disconnect();
    await mongo.client.close();
  });

  it("rebuild clears and replays — order doc ends at status ACCEPTED v2", async () => {
    const { events } = await rebuildProjection();

    expect(events).toBeGreaterThanOrEqual(2);

    const doc = await mongo.db
      .collection(READ_COLLECTIONS.ORDERS)
      .findOne({ _id: `berlin:${orderId}` as never });

    expect(doc).toMatchObject({
      tenantId: "berlin",
      orderId,
      customerId,
      totalAmount,
      status: "ACCEPTED",
      version: 2,
    });
  });

  it("is idempotent — second rebuild yields the same read-model state", async () => {
    const { events: events2 } = await rebuildProjection();

    expect(events2).toBeGreaterThanOrEqual(2);

    const doc = await mongo.db
      .collection(READ_COLLECTIONS.ORDERS)
      .findOne({ _id: `berlin:${orderId}` as never });

    expect(doc).toMatchObject({
      status: "ACCEPTED",
      version: 2,
    });

    // Confirm there is exactly one doc for this order (no duplicate upserts)
    const count = await mongo.db
      .collection(READ_COLLECTIONS.ORDERS)
      .countDocuments({ orderId });
    expect(count).toBe(1);
  });
});
