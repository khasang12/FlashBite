import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { MongoService } from "@flashbite/shared";
import { READ_COLLECTIONS, ORDER_STATUS } from "@flashbite/contracts";

describe("read-api orders query (e2e)", () => {
  let app: INestApplication;
  let mongo: MongoService;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    mongo = app.get(MongoService);
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

    const res = await request(app.getHttpServer()).get(`/orders/${orderId}`).set("X-Tenant-ID", "berlin");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orderId, status: "PLACED", totalAmount: 1200, tenantId: "berlin" });

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` as never });
  });

  it("returns 404 for a missing order", async () => {
    const res = await request(app.getHttpServer()).get(`/orders/${randomUUID()}`).set("X-Tenant-ID", "berlin");
    expect(res.status).toBe(404);
  });
});
