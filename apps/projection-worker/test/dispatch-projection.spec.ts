import { randomUUID } from "node:crypto";
import { connectMongo, MongoHandle, buildEnvelope } from "@flashbite/shared";
import {
  EVENT_TYPES,
  READ_COLLECTIONS,
  type DriverOfferedPayload,
  type DispatchAcceptedPayload,
  type OrderPickedUpPayload,
  type OrderDeliveredPayload,
} from "@flashbite/contracts";
import { applyDispatchEvent } from "../src/dispatch-projection";

describe("applyDispatchEvent", () => {
  let mongo: MongoHandle;

  beforeAll(async () => {
    mongo = await connectMongo();
  });

  afterAll(async () => {
    await mongo.client.close();
  });

  it("projects the full dispatch lifecycle and is idempotent on re-delivery", async () => {
    const orderId = randomUUID();
    const driverId = "d1";
    const tenantId = "berlin";
    const docId = `${tenantId}:${orderId}`;

    const offered = buildEnvelope<DriverOfferedPayload>({
      tenantId,
      eventType: EVENT_TYPES.DRIVER_OFFERED,
      version: 1,
      payload: { orderId, driverId },
    });
    const accepted = buildEnvelope<DispatchAcceptedPayload>({
      tenantId,
      eventType: EVENT_TYPES.DISPATCH_ACCEPTED,
      version: 2,
      payload: { orderId, driverId },
    });
    const pickedUp = buildEnvelope<OrderPickedUpPayload>({
      tenantId,
      eventType: EVENT_TYPES.ORDER_PICKED_UP,
      version: 3,
      payload: { orderId },
    });
    const delivered = buildEnvelope<OrderDeliveredPayload>({
      tenantId,
      eventType: EVENT_TYPES.ORDER_DELIVERED,
      version: 4,
      payload: { orderId },
    });

    expect(await applyDispatchEvent(mongo.db, offered)).toBe("applied");
    expect(await applyDispatchEvent(mongo.db, accepted)).toBe("applied");
    expect(await applyDispatchEvent(mongo.db, pickedUp)).toBe("applied");
    expect(await applyDispatchEvent(mongo.db, delivered)).toBe("applied");

    const doc = await mongo.db.collection(READ_COLLECTIONS.DISPATCHES).findOne({ _id: docId as never });
    expect(doc).toMatchObject({
      tenantId,
      orderId,
      status: "DELIVERED",
      driverId,
      offeredDriverId: driverId,
      version: 4,
    });

    // Idempotency — re-applying the first event returns "skipped" and does not regress
    const skipped = await applyDispatchEvent(mongo.db, offered);
    expect(skipped).toBe("skipped");

    const docAfterReplay = await mongo.db.collection(READ_COLLECTIONS.DISPATCHES).findOne({ _id: docId as never });
    expect(docAfterReplay?.status).toBe("DELIVERED");
    expect(docAfterReplay?.version).toBe(4);

    // Cleanup
    await mongo.db.collection(READ_COLLECTIONS.DISPATCHES).deleteOne({ _id: docId as never });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteMany({
      tenantId,
      eventId: { $in: [offered.eventId, accepted.eventId, pickedUp.eventId, delivered.eventId] },
    });
  });

  it("stamps offerExpiresAt = occurredAt + offerTimeoutSeconds on an OFFERED doc", async () => {
    const orderId = randomUUID();
    const docId = `berlin:${orderId}`;
    const offered = buildEnvelope<DriverOfferedPayload>({
      tenantId: "berlin",
      eventType: EVENT_TYPES.DRIVER_OFFERED,
      version: 1,
      occurredAt: "2026-06-21T00:00:00.000Z",
      payload: { orderId, driverId: "d1" },
    });
    expect(await applyDispatchEvent(mongo.db, offered, 90)).toBe("applied");
    const doc = await mongo.db.collection(READ_COLLECTIONS.DISPATCHES).findOne({ _id: docId as never });
    expect((doc as unknown as { offerExpiresAt?: string }).offerExpiresAt).toBe("2026-06-21T00:01:30.000Z");
    await mongo.db.collection(READ_COLLECTIONS.DISPATCHES).deleteOne({ _id: docId as never });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteMany({ tenantId: "berlin", eventId: offered.eventId });
  });
});
