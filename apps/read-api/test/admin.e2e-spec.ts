import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { MongoService } from "@flashbite/shared";
import { READ_COLLECTIONS, ORDER_STATUS } from "@flashbite/contracts";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";

describe("read-api operator console (e2e)", () => {
  let app: INestApplication;
  let mongo: MongoService;
  let auth: TestAuth;
  let operator: string;
  let merchant: string;
  const seededIds: string[] = [];

  const seedOrder = async (tenantId: string) => {
    const orderId = randomUUID();
    const _id = `${tenantId}:${orderId}`;
    seededIds.push(_id);
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).insertOne({
      _id: _id as never,
      tenantId,
      orderId,
      customerId: "c-1",
      items: [{ sku: "pizza", qty: 1, price: 1200 }],
      totalAmount: 1200,
      status: ORDER_STATUS.PLACED,
      version: 1,
      updatedAt: new Date().toISOString(),
    });
    return orderId;
  };

  beforeAll(async () => {
    auth = await createTestAuth();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    mongo = app.get(MongoService);
    operator = await auth.mint({ tenantId: "platform", role: "operator", sub: "op-1" });
    merchant = await auth.mint({ tenantId: "berlin", role: "merchant", sub: "m-1" });
  }, 30000);

  afterAll(async () => {
    for (const _id of seededIds) {
      await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: _id as never });
    }
    await app.close();
  });

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it("operator sees orders across all tenants", async () => {
    const berlinId = await seedOrder("berlin");
    const tokyoId = await seedOrder("tokyo");
    const res = await request(app.getHttpServer()).get("/admin/orders").set(bearer(operator));
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ orderId: string }>).map((o) => o.orderId);
    expect(ids).toEqual(expect.arrayContaining([berlinId, tokyoId]));
    const tenants = new Set((res.body as Array<{ tenantId: string }>).map((o) => o.tenantId));
    expect(tenants.has("berlin")).toBe(true);
    expect(tenants.has("tokyo")).toBe(true);
  });

  it("operator can list drivers across tenants (shape)", async () => {
    const res = await request(app.getHttpServer()).get("/admin/drivers").set(bearer(operator));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const d of res.body as Array<{ tenantId: string; driverId: string }>) {
      expect(typeof d.tenantId).toBe("string");
      expect(typeof d.driverId).toBe("string");
    }
  });

  it("rejects a non-operator role (403)", async () => {
    const res = await request(app.getHttpServer()).get("/admin/orders").set(bearer(merchant));
    expect(res.status).toBe(403);
  });

  it("rejects a request with no token (401)", async () => {
    const res = await request(app.getHttpServer()).get("/admin/orders");
    expect(res.status).toBe(401);
  });
});
