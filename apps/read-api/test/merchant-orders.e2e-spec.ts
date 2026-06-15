import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { MongoService } from "@flashbite/shared";
import { READ_COLLECTIONS, ORDER_STATUS, type OrderView } from "@flashbite/contracts";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";

describe("read-api merchant orders list (e2e)", () => {
  let app: INestApplication;
  let mongo: MongoService;
  let auth: TestAuth;
  let berlinToken: string;
  const ids: string[] = [];

  const seed = async (tenantId: string, status: string, updatedAt: string, cancelReason?: string) => {
    const orderId = randomUUID();
    ids.push(`${tenantId}:${orderId}`);
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).insertOne({
      _id: `${tenantId}:${orderId}` as never,
      tenantId, orderId, customerId: "c-1",
      items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200,
      status, version: 1, updatedAt, ...(cancelReason ? { cancelReason } : {}),
    });
    return orderId;
  };

  beforeAll(async () => {
    auth = await createTestAuth();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    mongo = app.get(MongoService);
    berlinToken = await auth.mint({ tenantId: "berlin", role: "merchant", sub: "m-1" });
  }, 30000);
  afterAll(async () => {
    for (const _id of ids) await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: _id as never });
    await app.close();
  });

  it("returns the tenant's recent orders newest-first, across statuses, excluding other tenants", async () => {
    const older = await seed("berlin", ORDER_STATUS.ACCEPTED, "2026-06-14T10:00:00.000Z");
    const newer = await seed("berlin", ORDER_STATUS.PLACED, "2026-06-14T11:00:00.000Z");
    const tokyo = await seed("tokyo", ORDER_STATUS.PLACED, "2026-06-14T12:00:00.000Z");

    const res = await request(app.getHttpServer())
      .get("/merchant/orders")
      .set("Authorization", `Bearer ${berlinToken}`);
    expect(res.status).toBe(200);
    const body = res.body as OrderView[];
    const orderIds = body.map((o) => o.orderId);

    expect(orderIds).toContain(newer);
    expect(orderIds).toContain(older);
    expect(orderIds).not.toContain(tokyo);
    expect(orderIds.indexOf(newer)).toBeLessThan(orderIds.indexOf(older));
    expect(body.every((o) => o.tenantId === "berlin")).toBe(true);
  });

  it("returns cancelReason on cancelled orders", async () => {
    const cancelled = await seed("berlin", ORDER_STATUS.CANCELLED, "2026-06-14T13:00:00.000Z", "SLA_BREACH");
    const res = await request(app.getHttpServer())
      .get("/merchant/orders")
      .set("Authorization", `Bearer ${berlinToken}`);
    const row = (res.body as OrderView[]).find((o) => o.orderId === cancelled);
    expect(row?.status).toBe(ORDER_STATUS.CANCELLED);
    expect(row?.cancelReason).toBe("SLA_BREACH");
  });
});
