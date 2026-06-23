import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";

describe("read-api /tenants + TenantGuard (e2e)", () => {
  let app: INestApplication;
  let auth: TestAuth;

  beforeAll(async () => {
    auth = await createTestAuth();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it("GET /tenants returns active tenants for a valid tenant user", async () => {
    const token = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c1" });
    const res = await request(app.getHttpServer())
      .get("/tenants")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((t: { slug: string }) => t.slug === "berlin")).toBe(true);
  });

  it("rejects a request whose tenantId is not an active catalog tenant (403)", async () => {
    const token = await auth.mint({ tenantId: "ghost-tenant", role: "customer", sub: "c1" });
    const res = await request(app.getHttpServer())
      .get("/tenants")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
