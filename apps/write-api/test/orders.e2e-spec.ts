import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@flashbite/shared";

describe("write-api orders (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
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

  it("writes an event_store row and a PENDING outbox row atomically", async () => {
    const orderId = randomUUID();
    const res = await request(app.getHttpServer())
      .post("/orders")
      .set("X-Tenant-ID", "berlin")
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
    await request(app.getHttpServer()).post("/orders").set("X-Tenant-ID", "berlin").send(body(orderId));
    const res2 = await request(app.getHttpServer())
      .post("/orders")
      .set("X-Tenant-ID", "berlin")
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
      .set("X-Tenant-ID", "berlin")
      .send({ orderId: "not-much" });
    expect(res.status).toBe(400);
  });
});
