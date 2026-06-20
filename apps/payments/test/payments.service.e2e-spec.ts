import { randomUUID } from "node:crypto";
import { PaymentsPrismaService } from "../src/payments-prisma.service";
import { PaymentsService } from "../src/payments.service";
import { PAYMENT_STATUS } from "@flashbite/contracts";

describe("PaymentsService (live flashbite_payments)", () => {
  const prisma = new PaymentsPrismaService();
  const svc = new PaymentsService(prisma);
  const THRESHOLD = 100000;
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });

  function ids() { return { tenantId: "berlin", orderId: randomUUID() }; }
  async function cleanup(orderId: string) { await prisma.payment.deleteMany({ where: { orderId } }); }

  it("authorizes below the threshold (idempotent)", async () => {
    const { tenantId, orderId } = ids();
    const a = await svc.authorize(tenantId, orderId, 1200, THRESHOLD, "auth:k");
    expect(a.outcome).toBe("authorized");
    const again = await svc.authorize(tenantId, orderId, 1200, THRESHOLD, "auth:k");
    expect(again.paymentId).toBe(a.paymentId);
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    await cleanup(orderId);
  });

  it("declines at/above the threshold", async () => {
    const { tenantId, orderId } = ids();
    const a = await svc.authorize(tenantId, orderId, 100000, THRESHOLD, "auth:k");
    expect(a.outcome).toBe("declined");
    const row = await prisma.payment.findFirst({ where: { orderId } });
    expect(row?.status).toBe(PAYMENT_STATUS.DECLINED);
    await cleanup(orderId);
  });

  it("captures an authorized payment (idempotent)", async () => {
    const { tenantId, orderId } = ids();
    await svc.authorize(tenantId, orderId, 1200, THRESHOLD, "auth:k");
    const c = await svc.capture(tenantId, orderId, "cap:k");
    expect(c.outcome).toBe("captured");
    const again = await svc.capture(tenantId, orderId, "cap:k");
    expect(again.outcome).toBe("captured");
    expect((await prisma.payment.findFirst({ where: { orderId } }))?.status).toBe(PAYMENT_STATUS.CAPTURED);
    await cleanup(orderId);
  });

  it("voids an authorized payment (idempotent)", async () => {
    const { tenantId, orderId } = ids();
    await svc.authorize(tenantId, orderId, 1200, THRESHOLD, "auth:k");
    const v = await svc.void(tenantId, orderId, "void:k");
    expect(v.outcome).toBe("voided");
    expect((await prisma.payment.findFirst({ where: { orderId } }))?.status).toBe(PAYMENT_STATUS.VOIDED);
    await cleanup(orderId);
  });

  it("rejects an illegal transition (capture a declined payment)", async () => {
    const { tenantId, orderId } = ids();
    await svc.authorize(tenantId, orderId, 100000, THRESHOLD, "auth:k");
    await expect(svc.capture(tenantId, orderId, "cap:k")).rejects.toThrow();
    await cleanup(orderId);
  });
});
