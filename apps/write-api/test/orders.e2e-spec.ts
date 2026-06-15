import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@flashbite/shared";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";

describe("write-api orders (e2e)", () => {
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
    prisma = app.get(PrismaService);
    customer = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
  });

  afterAll(async () => {
    await app.close();
  });

  const body = (orderId: string) => ({
    orderId,
    customerId: "c-1",
    items: [{ sku: "pizza", qty: 1, price: 1200 }],
    totalAmount: 1200,
  });

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it("writes an event_store row and a PENDING outbox row atomically", async () => {
    const orderId = randomUUID();
    const res = await request(app.getHttpServer())
      .post("/orders")
      .set(bearer(customer))
      .send(body(orderId));

    expect(res.status).toBe(201);
    expect(res.body.orderId).toBe(orderId);

    const events = await prisma.eventStore.findMany({
      where: { tenantId: "berlin", aggregateId: orderId },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("OrderPlaced");

    const outbox = await prisma.outbox.findMany({
      where: { tenantId: "berlin", partitionKey: `berlin:${orderId}` },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe("PENDING");
    expect(outbox[0].topic).toBe("order-events");
  });

  it("is idempotent — re-posting the same orderId does not duplicate", async () => {
    const orderId = randomUUID();
    await request(app.getHttpServer()).post("/orders").set(bearer(customer)).send(body(orderId));
    const res2 = await request(app.getHttpServer())
      .post("/orders")
      .set(bearer(customer))
      .send(body(orderId));

    expect(res2.status).toBe(201);
    const events = await prisma.eventStore.findMany({
      where: { tenantId: "berlin", aggregateId: orderId },
    });
    expect(events).toHaveLength(1);
    const outbox = await prisma.outbox.findMany({
      where: { tenantId: "berlin", partitionKey: `berlin:${orderId}` },
    });
    expect(outbox).toHaveLength(1);
  });

  it("rejects an invalid payload with 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/orders")
      .set(bearer(customer))
      .send({ orderId: "not-much" });
    expect(res.status).toBe(400);
  });

  it("rejects a request with no token (401)", async () => {
    const res = await request(app.getHttpServer()).post("/orders").send(body(randomUUID()));
    expect(res.status).toBe(401);
  });

  it("rejects a non-customer role (403)", async () => {
    const merchant = await auth.mint({ tenantId: "berlin", role: "merchant", sub: "m-1" });
    const res = await request(app.getHttpServer())
      .post("/orders")
      .set(bearer(merchant))
      .send(body(randomUUID()));
    expect(res.status).toBe(403);
  });

  it("derives the tenant from the token, not a header", async () => {
    const tokyo = await auth.mint({ tenantId: "tokyo", role: "customer", sub: "c-9" });
    const orderId = randomUUID();
    await request(app.getHttpServer()).post("/orders").set(bearer(tokyo)).send(body(orderId));
    const events = await prisma.eventStore.findMany({ where: { aggregateId: orderId } });
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe("tokyo");
  });
});
