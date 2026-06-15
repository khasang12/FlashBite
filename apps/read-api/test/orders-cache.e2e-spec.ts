import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { MongoService, RedisService } from "@flashbite/shared";
import { READ_COLLECTIONS, ORDER_STATUS, tenantKey } from "@flashbite/contracts";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";

describe("read-api orders cache-aside (e2e)", () => {
  let app: INestApplication;
  let mongo: MongoService;
  let redis: RedisService;
  let auth: TestAuth;
  let berlinToken: string;

  beforeAll(async () => {
    auth = await createTestAuth();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    mongo = app.get(MongoService);
    redis = app.get(RedisService);
    berlinToken = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
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

    const r1 = await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set("Authorization", `Bearer ${berlinToken}`);
    expect(r1.status).toBe(200);
    expect(r1.body.totalAmount).toBe(700);
    const cached = await redis.cluster.get(cacheKey);
    expect(cached).not.toBeNull();

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).updateOne({ _id: id as never }, { $set: { totalAmount: 9999 } });
    const r2 = await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set("Authorization", `Bearer ${berlinToken}`);
    expect(r2.body.totalAmount).toBe(700); // served from cache

    await redis.cluster.del(cacheKey);
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: id as never });
  });
});
