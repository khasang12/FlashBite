import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@flashbite/shared";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";

describe("write-api correlationId propagation (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: TestAuth;
  let customer: string;

  beforeAll(async () => {
    auth = await createTestAuth();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // Superuser client (DATABASE_URL env) — bypasses RLS so we can read back outbox rows.
    prisma = new PrismaService();
    await prisma.onModuleInit();
    customer = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await app.close();
  });

  const body = (orderId: string) => ({
    orderId,
    customerId: "c-1",
    items: [{ sku: "pizza", qty: 1, price: 1200 }],
    totalAmount: 1200,
  });

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it("propagates an inbound x-correlation-id onto the persisted outbox envelope", async () => {
    const orderId = randomUUID();
    const corr = `e2e-corr-${Date.now()}`;

    const res = await request(app.getHttpServer())
      .post("/orders")
      .set(bearer(customer))
      .set("x-correlation-id", corr)
      .send(body(orderId));

    expect(res.status).toBe(201);
    expect(res.body.orderId).toBe(orderId);

    // The outbox row id == eventId == the envelope stored as payload.
    // Querying by partitionKey mirrors the pattern used by orders.e2e-spec.ts.
    const rows = await prisma.outbox.findMany({
      where: { tenantId: "berlin", partitionKey: `berlin:${orderId}` },
    });
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as Record<string, unknown>).correlationId).toBe(corr);
  });

  it("mints a new correlationId when none is supplied and stores it on the outbox envelope", async () => {
    const orderId = randomUUID();

    const res = await request(app.getHttpServer())
      .post("/orders")
      .set(bearer(customer))
      .send(body(orderId));

    expect(res.status).toBe(201);

    const rows = await prisma.outbox.findMany({
      where: { tenantId: "berlin", partitionKey: `berlin:${orderId}` },
    });
    expect(rows).toHaveLength(1);
    const storedCorr = (rows[0].payload as Record<string, unknown>).correlationId;
    expect(typeof storedCorr).toBe("string");
    expect((storedCorr as string).length).toBeGreaterThan(0);
  });
});
