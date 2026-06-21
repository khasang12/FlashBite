import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";
import { PaymentsClient } from "../src/orders/payments-client";

describe("read-api order payment (e2e)", () => {
  let app: INestApplication;
  let auth: TestAuth;
  let berlinToken: string;
  let tokyoToken: string;
  const calls: Array<{ tenantId: string; orderId: string }> = [];
  const KNOWN = randomUUID();

  // Fake payments client: keys off the tenantId the controller derives from the JWT,
  // so a tokyo token never sees a berlin payment.
  const fakeClient = {
    async getPayment(tenantId: string, orderId: string) {
      calls.push({ tenantId, orderId });
      if (tenantId === "berlin" && orderId === KNOWN) return { status: "AUTHORIZED" as const };
      return null;
    },
  };

  beforeAll(async () => {
    auth = await createTestAuth();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .overrideProvider(PaymentsClient)
      .useValue(fakeClient)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    berlinToken = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
    tokyoToken = await auth.mint({ tenantId: "tokyo", role: "customer", sub: "c-9" });
  });
  afterAll(async () => { await app.close(); });

  it("returns the payment status for an order with a payment", async () => {
    const res = await request(app.getHttpServer())
      .get(`/orders/${KNOWN}/payment`)
      .set("Authorization", `Bearer ${berlinToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "AUTHORIZED" });
  });

  it("returns { status: null } when there is no payment yet", async () => {
    const res = await request(app.getHttpServer())
      .get(`/orders/${randomUUID()}/payment`)
      .set("Authorization", `Bearer ${berlinToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: null });
  });

  it("is tenant-scoped — a tokyo token never sees a berlin payment", async () => {
    calls.length = 0;
    const res = await request(app.getHttpServer())
      .get(`/orders/${KNOWN}/payment`)
      .set("Authorization", `Bearer ${tokyoToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: null });
    expect(calls.at(-1)).toEqual({ tenantId: "tokyo", orderId: KNOWN }); // JWT tenant, not a path param
  });

  it("rejects with no token (401)", async () => {
    const res = await request(app.getHttpServer()).get(`/orders/${KNOWN}/payment`);
    expect(res.status).toBe(401);
  });
});
