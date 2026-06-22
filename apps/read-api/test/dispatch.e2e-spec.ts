import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";
import { MongoService, RedisService } from "@flashbite/shared";
import { driverOnlineKey, READ_COLLECTIONS } from "@flashbite/contracts";

describe("read-api dispatch (e2e)", () => {
  let app: INestApplication;
  let auth: TestAuth;
  let berlinDriverToken: string;
  let tokyoDriverToken: string;
  let customerToken: string;
  let mongo: MongoService;
  let redis: RedisService;

  const orderId = randomUUID();
  const driverId = "d1";

  const dispatchDoc = {
    _id: `berlin:${orderId}`,
    tenantId: "berlin",
    orderId,
    status: "DISPATCHED",
    driverId,
    version: 1,
    updatedAt: "t",
  };

  beforeAll(async () => {
    auth = await createTestAuth();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = mod.createNestApplication();
    await app.init();

    mongo = mod.get(MongoService);
    redis = mod.get(RedisService);

    berlinDriverToken = await auth.mint({ tenantId: "berlin", role: "driver", sub: "d1" });
    tokyoDriverToken = await auth.mint({ tenantId: "tokyo", role: "driver", sub: "d9" });
    customerToken = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });

    await mongo.db.collection(READ_COLLECTIONS.DISPATCHES).insertOne(dispatchDoc as never);
  });

  afterAll(async () => {
    await mongo.db.collection(READ_COLLECTIONS.DISPATCHES).deleteOne({ _id: `berlin:${orderId}` as never });
    await redis.cluster.srem(driverOnlineKey("berlin"), driverId);
    await app.close();
  });

  it("GET /orders/:orderId/dispatch returns dispatch for tenant (berlin) WITHOUT driver identity", async () => {
    const res = await request(app.getHttpServer())
      .get(`/orders/${orderId}/dispatch`)
      .set("Authorization", `Bearer ${berlinDriverToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "DISPATCHED" });
    // driver identity must be stripped at the customer/merchant-facing read boundary
    expect(res.body.driverId).toBeUndefined();
    expect(res.body.offeredDriverId).toBeUndefined();
  });

  it("GET /orders/:orderId/dispatch returns {status:null} for different tenant (tokyo isolation)", async () => {
    const res = await request(app.getHttpServer())
      .get(`/orders/${orderId}/dispatch`)
      .set("Authorization", `Bearer ${tokyoDriverToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: null });
  });

  it("POST /drivers/:driverId/online → 202 and sets Redis key", async () => {
    const res = await request(app.getHttpServer())
      .post(`/drivers/${driverId}/online`)
      .set("Authorization", `Bearer ${berlinDriverToken}`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ driverId, online: true });

    const isMember = await redis.cluster.sismember(driverOnlineKey("berlin"), driverId);
    expect(isMember).toBe(1);
  });

  it("POST /drivers/:driverId/offline → 202 and clears Redis key", async () => {
    const res = await request(app.getHttpServer())
      .post(`/drivers/${driverId}/offline`)
      .set("Authorization", `Bearer ${berlinDriverToken}`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ driverId, online: false });

    const isMember = await redis.cluster.sismember(driverOnlineKey("berlin"), driverId);
    expect(isMember).toBe(0);
  });

  it("GET /driver/dispatch returns active dispatch for driver (berlin)", async () => {
    const res = await request(app.getHttpServer())
      .get(`/driver/dispatch?driverId=${driverId}`)
      .set("Authorization", `Bearer ${berlinDriverToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "DISPATCHED", driverId });
  });

  it("GET /driver/dispatch with non-driver token → 403", async () => {
    const res = await request(app.getHttpServer())
      .get(`/driver/dispatch?driverId=${driverId}`)
      .set("Authorization", `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });
});
