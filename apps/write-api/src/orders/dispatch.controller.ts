import { Body, Controller, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { getTenantId, Roles } from "@flashbite/tenant-context";
import { DISPATCH_SAGA, ROLES } from "@flashbite/contracts";
import { TemporalService } from "../temporal/temporal.service";

const SIGNALS: Record<string, string> = {
  accept: DISPATCH_SAGA.ACCEPT_SIGNAL,
  reject: DISPATCH_SAGA.REJECT_SIGNAL,
  pickup: DISPATCH_SAGA.PICKUP_SIGNAL,
  deliver: DISPATCH_SAGA.DELIVER_SIGNAL,
};

@Controller("dispatch")
export class DispatchController {
  constructor(private readonly temporal: TemporalService) {}

  @Post(":orderId/:action")
  @HttpCode(202)
  @Roles(ROLES.DRIVER)
  async signal(
    @Param("orderId") orderId: string,
    @Param("action") action: string,
    @Body() body: { driverId: string },
  ): Promise<{ orderId: string; action: string }> {
    const signal = SIGNALS[action];
    if (!signal) throw new NotFoundException(`unknown dispatch action ${action}`);
    const tenantId = getTenantId();
    const handle = this.temporal.client.workflow.getHandle(`dispatch:${tenantId}:${orderId}`);
    try {
      await handle.signal(signal, body.driverId);
    } catch (err) {
      if (/not found|NotFound/i.test(String(err))) throw new NotFoundException(`No active dispatch for ${orderId}`);
      throw err;
    }
    return { orderId, action };
  }
}
