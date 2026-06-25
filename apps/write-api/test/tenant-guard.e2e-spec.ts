import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";
import { TokenVerifier } from "@flashbite/tenant-context";
import { AppModule } from "../src/app.module";

describe("write-api TenantGuard (e2e)", () => {
  let app: INestApplication;
  let auth: TestAuth;

  beforeAll(async () => {
    auth = await createTestAuth();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a write from a non-catalog tenant with 403", async () => {
    const token = await auth.mint({ tenantId: "ghost-tenant", role: "customer", sub: "c1" });
    const res = await request(app.getHttpServer())
      .post("/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "o-guard-1", customerId: "c1", items: [], totalAmount: 0 });
    expect(res.status).toBe(403);
  });
});
