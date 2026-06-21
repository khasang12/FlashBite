import { Body, Controller, Post } from "@nestjs/common";
import type { PaymentOutcome } from "./payments.service";
import { PaymentsService } from "./payments.service";
import { AuthorizeDto, CaptureVoidDto } from "./dto";

const DECLINE_THRESHOLD = Number(process.env.AUTH_DECLINE_THRESHOLD ?? 100000);

@Controller("payments")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post("authorize")
  authorize(@Body() body: AuthorizeDto): Promise<PaymentOutcome> {
    return this.payments.authorize(body.tenantId, body.orderId, body.amount, DECLINE_THRESHOLD, body.idempotencyKey);
  }

  @Post("capture")
  capture(@Body() body: CaptureVoidDto): Promise<PaymentOutcome> {
    return this.payments.capture(body.tenantId, body.orderId, body.idempotencyKey);
  }

  @Post("void")
  void(@Body() body: CaptureVoidDto): Promise<PaymentOutcome> {
    return this.payments.void(body.tenantId, body.orderId, body.idempotencyKey);
  }
}
