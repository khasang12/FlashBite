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

describe("read-api orders query (e2e)", () => {
  let app: INestApplication;
  let mongo: MongoService;
  let auth: TestAuth;
  let berlinToken: string;
  let tokyoToken: string;

  beforeAll(async () => {
    auth = await createTestAuth();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    mongo = app.get(MongoService);
    berlinToken = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
    tokyoToken = await auth.mint({ tenantId: "tokyo", role: "customer", sub: "c-9" });
  });
  afterAll(async () => { await app.close(); });

  it("returns a seeded order view", async () => {
    const orderId = randomUUID();
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).insertOne({
      _id: `berlin:${orderId}` as never,
      tenantId: "berlin", orderId, customerId: "c-1",
      items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200,
      status: ORDER_STATUS.PLACED, version: 1, updatedAt: new Date().toISOString(),
    });

    const res = await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set("Authorization", `Bearer ${berlinToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orderId, status: "PLACED", totalAmount: 1200, tenantId: "berlin" });

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` as never });
  });

  it("returns 404 for a missing order", async () => {
    const res = await request(app.getHttpServer())
      .get(`/orders/${randomUUID()}`)
      .set("Authorization", `Bearer ${berlinToken}`);
    expect(res.status).toBe(404);
  });

  it("does not return tokyo order to berlin token", async () => {
    const orderId = randomUUID();
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).insertOne({
      _id: `tokyo:${orderId}` as never,
      tenantId: "tokyo", orderId, customerId: "c-9",
      items: [], totalAmount: 500,
      status: ORDER_STATUS.PLACED, version: 1, updatedAt: new Date().toISOString(),
    });

    const res = await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set("Authorization", `Bearer ${berlinToken}`);
    expect(res.status).toBe(404);

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `tokyo:${orderId}` as never });
  });

  it("does not return berlin order to tokyo token", async () => {
    const orderId = randomUUID();
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).insertOne({
      _id: `berlin:${orderId}` as never,
      tenantId: "berlin", orderId, customerId: "c-1",
      items: [{ sku: "burger", qty: 2, price: 900 }], totalAmount: 1800,
      status: ORDER_STATUS.PLACED, version: 1, updatedAt: new Date().toISOString(),
    });

    const res = await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set("Authorization", `Bearer ${tokyoToken}`);
    expect(res.status).toBe(404);

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` as never });
  });

  it("rejects a query with no token (401)", async () => {
    const res = await request(app.getHttpServer()).get(
      "/orders/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(401);
  });
});
