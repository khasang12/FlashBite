import { randomUUID } from "node:crypto";
import { connectMongo, MongoHandle } from "@flashbite/shared";
import {
  buildEnvelope,
  EVENT_TYPES,
  READ_COLLECTIONS,
  type OrderPlacedPayload,
} from "@flashbite/contracts";
import { applyEvent } from "../src/projection";

describe("applyEvent", () => {
  let mongo: MongoHandle;
  beforeAll(async () => {
    mongo = await connectMongo();
  });
  afterAll(async () => {
    await mongo.client.close();
  });

  const placed = (orderId: string) => {
    const payload: OrderPlacedPayload = {
      orderId,
      customerId: "c-1",
      items: [{ sku: "pizza", qty: 1, price: 1200 }],
      totalAmount: 1200,
    };
    return buildEnvelope({ tenantId: "berlin", eventType: EVENT_TYPES.ORDER_PLACED, version: 1, payload });
  };

  it("projects an OrderPlaced into the orders read model", async () => {
    const orderId = randomUUID();
    const result = await applyEvent(mongo.db, placed(orderId));
    expect(result).toBe("applied");

    const doc = await mongo.db.collection(READ_COLLECTIONS.ORDERS).findOne({ _id: `berlin:${orderId}` as never });
    expect(doc).toMatchObject({ tenantId: "berlin", orderId, status: "PLACED", version: 1, totalAmount: 1200 });

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` as never });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteMany({ tenantId: "berlin", eventId: { $exists: true } });
  });

  it("is idempotent — the same envelope applied twice yields one doc and is skipped the 2nd time", async () => {
    const env = placed(randomUUID());
    const first = await applyEvent(mongo.db, env);
    const second = await applyEvent(mongo.db, env);
    expect(first).toBe("applied");
    expect(second).toBe("skipped");

    const count = await mongo.db.collection(READ_COLLECTIONS.ORDERS).countDocuments({ orderId: (env.payload as OrderPlacedPayload).orderId });
    expect(count).toBe(1);

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${(env.payload as OrderPlacedPayload).orderId}` as never });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteOne({ _id: `berlin:projection-worker:${env.eventId}` as never });
  });

  it("ignores an older version for an existing aggregate", async () => {
    const orderId = randomUUID();
    const v2 = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 2,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: 999 } as OrderPlacedPayload,
    });
    await applyEvent(mongo.db, v2);
    const v1 = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 1,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: 111 } as OrderPlacedPayload,
    });
    await applyEvent(mongo.db, v1);

    const doc = await mongo.db.collection(READ_COLLECTIONS.ORDERS).findOne({ _id: `berlin:${orderId}` as never });
    expect(doc?.version).toBe(2);
    expect(doc?.totalAmount).toBe(999);

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` as never });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteOne({ _id: `berlin:projection-worker:${v2.eventId}` as never });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteOne({ _id: `berlin:projection-worker:${v1.eventId}` as never });
  });

  it("transitions an existing order to ACCEPTED on OrderAccepted (v2)", async () => {
    const orderId = randomUUID();
    const place = placed(orderId);
    await applyEvent(mongo.db, place); // v1 -> PLACED
    const accepted = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_ACCEPTED,
      version: 2,
      payload: { orderId },
    });
    const r = await applyEvent(mongo.db, accepted);
    expect(r).toBe("applied");

    const doc = await mongo.db.collection(READ_COLLECTIONS.ORDERS).findOne({ _id: `berlin:${orderId}` as never });
    expect(doc?.status).toBe("ACCEPTED");
    expect(doc?.version).toBe(2);

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` as never });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteMany({ _id: { $in: [`berlin:projection-worker:${place.eventId}`, `berlin:projection-worker:${accepted.eventId}`] } } as never);
  });

  it("transitions an existing order to CANCELLED on OrderCancelled (v2)", async () => {
    const orderId = randomUUID();
    const place = placed(orderId);
    await applyEvent(mongo.db, place);
    const cancelled = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_CANCELLED,
      version: 2,
      payload: { orderId, reason: "SLA_BREACH" },
    });
    await applyEvent(mongo.db, cancelled);

    const doc = await mongo.db.collection(READ_COLLECTIONS.ORDERS).findOne({ _id: `berlin:${orderId}` as never });
    expect(doc?.status).toBe("CANCELLED");
    expect(doc?.version).toBe(2);

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` as never });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteMany({ _id: { $in: [`berlin:projection-worker:${place.eventId}`, `berlin:projection-worker:${cancelled.eventId}`] } } as never);
  });
});
