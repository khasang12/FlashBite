import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("payments HTTP (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it("authorize -> capture happy path", async () => {
    const orderId = randomUUID();
    const auth = await request(app.getHttpServer())
      .post("/payments/authorize")
      .send({ tenantId: "berlin", orderId, amount: 1200, idempotencyKey: `auth:berlin:${orderId}` })
      .expect(201);
    expect(auth.body.outcome).toBe("authorized");

    const cap = await request(app.getHttpServer())
      .post("/payments/capture")
      .send({ tenantId: "berlin", orderId, idempotencyKey: `capture:berlin:${orderId}` })
      .expect(201);
    expect(cap.body.outcome).toBe("captured");
  });

  it("declines at/above the threshold", async () => {
    const orderId = randomUUID();
    const auth = await request(app.getHttpServer())
      .post("/payments/authorize")
      .send({ tenantId: "berlin", orderId, amount: 100000, idempotencyKey: `auth:berlin:${orderId}` })
      .expect(201);
    expect(auth.body.outcome).toBe("declined");
  });

  it("400 on a malformed body (missing amount)", async () => {
    await request(app.getHttpServer())
      .post("/payments/authorize")
      .send({ tenantId: "berlin", orderId: "x", idempotencyKey: "k" })
      .expect(400);
  });
});
