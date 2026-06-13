import { Controller, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { getTenantId } from "@flashbite/tenant-context";
import { TemporalService } from "../temporal/temporal.service";

const MERCHANT_APPROVAL_SIGNAL = "merchantApproval";

@Controller("orders")
export class AcceptController {
  constructor(private readonly temporal: TemporalService) {}

  @Post(":orderId/accept")
  @HttpCode(202)
  async accept(@Param("orderId") orderId: string): Promise<{ orderId: string; signalled: string }> {
    return this.signal(orderId, true);
  }

  @Post(":orderId/decline")
  @HttpCode(202)
  async decline(@Param("orderId") orderId: string): Promise<{ orderId: string; signalled: string }> {
    return this.signal(orderId, false);
  }

  private async signal(orderId: string, approved: boolean): Promise<{ orderId: string; signalled: string }> {
    const tenantId = getTenantId();
    const handle = this.temporal.client.workflow.getHandle(`${tenantId}:${orderId}`);
    try {
      await handle.signal(MERCHANT_APPROVAL_SIGNAL, approved);
    } catch (err) {
      if (/not found|NotFound/i.test(String(err))) {
        throw new NotFoundException(`No active order workflow for ${orderId}`);
      }
      throw err;
    }
    return { orderId, signalled: approved ? "accept" : "decline" };
  }
}
