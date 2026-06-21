import { ConflictException, Controller, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { getTenantId, Roles } from "@flashbite/tenant-context";
import { ORDER_SAGA, PAYMENT_STATUS, ROLES } from "@flashbite/contracts";
import { TemporalService } from "../temporal/temporal.service";
import { PaymentsClient } from "./payments-client";

@Controller("orders")
export class AcceptController {
  constructor(
    private readonly temporal: TemporalService,
    private readonly payments: PaymentsClient,
  ) {}

  @Post(":orderId/accept")
  @HttpCode(202)
  @Roles(ROLES.MERCHANT)
  async accept(@Param("orderId") orderId: string): Promise<{ orderId: string; signalled: string }> {
    return this.signal(orderId, true);
  }

  @Post(":orderId/decline")
  @HttpCode(202)
  @Roles(ROLES.MERCHANT)
  async decline(@Param("orderId") orderId: string): Promise<{ orderId: string; signalled: string }> {
    return this.signal(orderId, false);
  }

  private async signal(orderId: string, approved: boolean): Promise<{ orderId: string; signalled: string }> {
    const tenantId = getTenantId();
    const status = await this.payments.getStatus(tenantId, orderId);
    if (status !== PAYMENT_STATUS.AUTHORIZED) {
      throw new ConflictException(`Order ${orderId} payment is not authorized (status: ${status ?? "none"})`);
    }
    const handle = this.temporal.client.workflow.getHandle(`${tenantId}:${orderId}`);
    try {
      await handle.signal(ORDER_SAGA.MERCHANT_APPROVAL_SIGNAL, approved);
    } catch (err) {
      if (/not found|NotFound/i.test(String(err))) {
        throw new NotFoundException(`No active order workflow for ${orderId}`);
      }
      throw err;
    }
    return { orderId, signalled: approved ? "accept" : "decline" };
  }
}
