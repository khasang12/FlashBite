import { Injectable, NotFoundException, ConflictException, Inject } from "@nestjs/common";
import { PAYMENT_STATUS, type PaymentStatus } from "@flashbite/contracts";
import { APP_LOGGER, type Logger } from "@flashbite/tenant-context";
import { PaymentsPrismaService } from "./payments-prisma.service";
import { decideAuthorize, nextOnCapture, nextOnVoid, IllegalTransitionError } from "./payment-rules";

export interface PaymentOutcome {
  paymentId: string;
  outcome: "authorized" | "declined" | "captured" | "voided";
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PaymentsPrismaService,
    @Inject(APP_LOGGER) private readonly log: Logger,
  ) {}

  /** Idempotent: one payment row per (tenantId, orderId). Re-authorize returns the prior decision. */
  async authorize(
    tenantId: string,
    orderId: string,
    amount: number,
    declineThreshold: number,
    idempotencyKey: string,
  ): Promise<PaymentOutcome> {
    this.log.info({ tenantId, orderId, amount, idempotencyKey }, "authorize");
    const existing = await this.prisma.payment.findUnique({ where: { tenantId_orderId: { tenantId, orderId } } });
    if (existing) {
      return { paymentId: existing.id, outcome: existing.status === PAYMENT_STATUS.DECLINED ? "declined" : "authorized" };
    }
    const status = decideAuthorize(amount, declineThreshold);
    const row = await this.prisma.payment.create({
      data: {
        tenantId,
        orderId,
        amount,
        status,
        authorizedAt: status === PAYMENT_STATUS.AUTHORIZED ? new Date() : null,
      },
    });
    return { paymentId: row.id, outcome: status === PAYMENT_STATUS.DECLINED ? "declined" : "authorized" };
  }

  async capture(tenantId: string, orderId: string, idempotencyKey: string): Promise<PaymentOutcome> {
    this.log.info({ tenantId, orderId, idempotencyKey }, "capture");
    return this.transition(tenantId, orderId, nextOnCapture, "capturedAt", "captured");
  }

  /** Read a payment by natural key. Returns null when none exists (caller maps to 404). */
  async get(tenantId: string, orderId: string): Promise<{ orderId: string; status: PaymentStatus; amount: number } | null> {
    const row = await this.prisma.payment.findUnique({ where: { tenantId_orderId: { tenantId, orderId } } });
    if (!row) return null;
    return { orderId: row.orderId, status: row.status as PaymentStatus, amount: row.amount };
  }

  async void(tenantId: string, orderId: string, idempotencyKey: string): Promise<PaymentOutcome> {
    this.log.info({ tenantId, orderId, idempotencyKey }, "void");
    return this.transition(tenantId, orderId, nextOnVoid, "voidedAt", "voided");
  }

  private async transition(
    tenantId: string,
    orderId: string,
    next: (s: PaymentStatus) => PaymentStatus,
    stampField: "capturedAt" | "voidedAt",
    outcome: "captured" | "voided",
  ): Promise<PaymentOutcome> {
    const row = await this.prisma.payment.findUnique({ where: { tenantId_orderId: { tenantId, orderId } } });
    if (!row) throw new NotFoundException(`No payment for ${tenantId}:${orderId}`);
    let target: PaymentStatus;
    try {
      target = next(row.status as PaymentStatus);
    } catch (e) {
      if (e instanceof IllegalTransitionError) throw new ConflictException(e.message);
      throw e;
    }
    if (row.status !== target) {
      await this.prisma.payment.update({
        where: { tenantId_orderId: { tenantId, orderId } },
        data: { status: target, [stampField]: new Date() },
      });
    }
    return { paymentId: row.id, outcome };
  }
}
