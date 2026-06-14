import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { RedisService } from "@flashbite/shared";
import { driverGeoKey } from "@flashbite/contracts";

describe("read-api nearby drivers (e2e)", () => {
  let app: INestApplication;
  let redis: RedisService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    redis = app.get(RedisService);
  }, 30000);
  afterAll(async () => {
    await app.close();
  });

  it("returns drivers within the radius for the tenant", async () => {
    const near = `near-${randomUUID()}`;
    const far = `far-${randomUUID()}`;
    // Berlin centre ~ (13.405, 52.52); near ~1km away, far ~ Munich (very far)
    await redis.cluster.geoadd(driverGeoKey("berlin"), 13.41, 52.52, near);
    await redis.cluster.geoadd(driverGeoKey("berlin"), 11.58, 48.14, far);

    const res = await request(app.getHttpServer())
      .get(`/drivers/nearby?lng=13.405&lat=52.52&radiusKm=5`)
      .set("X-Tenant-ID", "berlin");
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ driverId: string }>).map((d) => d.driverId);
    expect(ids).toContain(near);
    expect(ids).not.toContain(far);

    await redis.cluster.zrem(driverGeoKey("berlin"), near, far);
  });

  it("does not see another tenant's drivers", async () => {
    const tokyoDriver = `tk-${randomUUID()}`;
    await redis.cluster.geoadd(driverGeoKey("tokyo"), 13.405, 52.52, tokyoDriver);
    const res = await request(app.getHttpServer())
      .get(`/drivers/nearby?lng=13.405&lat=52.52&radiusKm=5`)
      .set("X-Tenant-ID", "berlin");
    const ids = (res.body as Array<{ driverId: string }>).map((d) => d.driverId);
    expect(ids).not.toContain(tokyoDriver);
    await redis.cluster.zrem(driverGeoKey("tokyo"), tokyoDriver);
  });
});
