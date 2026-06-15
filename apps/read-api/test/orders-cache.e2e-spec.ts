import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { MongoService, RedisService } from "@flashbite/shared";
import { READ_COLLECTIONS, ORDER_STATUS, tenantKey } from "@flashbite/contracts";

describe("read-api orders cache-aside (e2e)", () => {
  let app: INestApplication;
  let mongo: MongoService;
  let redis: RedisService;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    mongo = app.get(MongoService);
    redis = app.get(RedisService);
  });
  afterAll(async () => { await app.close(); });

  it("populates the redis cache on first read and serves the cached value after", async () => {
    const orderId = randomUUID();
    const id = `berlin:${orderId}`;
    const cacheKey = tenantKey("berlin", "order", orderId, "view");
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).insertOne({
      _id: id as never,
      tenantId: "berlin", orderId, customerId: "c-1", items: [],
      totalAmount: 700, status: ORDER_STATUS.PLACED, version: 1, updatedAt: "t0",
    });

    const r1 = await request(app.getHttpServer()).get(`/orders/${orderId}`).set("X-Tenant-ID", "berlin");
    expect(r1.status).toBe(200);
    expect(r1.body.totalAmount).toBe(700);
    const cached = await redis.cluster.get(cacheKey);
    expect(cached).not.toBeNull();

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).updateOne({ _id: id as never }, { $set: { totalAmount: 9999 } });
    const r2 = await request(app.getHttpServer()).get(`/orders/${orderId}`).set("X-Tenant-ID", "berlin");
    expect(r2.body.totalAmount).toBe(700); // served from cache

    await redis.cluster.del(cacheKey);
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: id as never });
  });
});
