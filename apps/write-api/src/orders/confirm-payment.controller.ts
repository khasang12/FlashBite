import { Controller, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { getTenantId, Roles } from "@flashbite/tenant-context";
import { ORDER_SAGA, ROLES } from "@flashbite/contracts";
import { TemporalService } from "../temporal/temporal.service";

@Controller("orders")
export class ConfirmPaymentController {
  constructor(private readonly temporal: TemporalService) {}

  @Post(":orderId/confirm-payment")
  @HttpCode(202)
  @Roles(ROLES.CUSTOMER)
  async confirm(@Param("orderId") orderId: string): Promise<{ orderId: string; signalled: string }> {
    const tenantId = getTenantId();
    const handle = this.temporal.client.workflow.getHandle(`${tenantId}:${orderId}`);
    try {
      await handle.signal(ORDER_SAGA.CONFIRM_PAYMENT_SIGNAL);
    } catch (err) {
      if (/not found|NotFound/i.test(String(err))) {
        throw new NotFoundException(`No active order workflow for ${orderId}`);
      }
      throw err;
    }
    return { orderId, signalled: "confirm-payment" };
  }
}
