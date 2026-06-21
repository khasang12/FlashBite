import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { Roles, RolesGuard } from "@flashbite/tenant-context";
import { ROLES, type DispatchView } from "@flashbite/contracts";
import { currentTenant } from "../tenant-scope";
import { DispatchQueryService } from "./dispatch-query.service";

@Controller()
@UseGuards(RolesGuard)
export class DispatchController {
  constructor(private readonly dispatch: DispatchQueryService) {}

  @Get("orders/:orderId/dispatch")
  async byOrder(@Param("orderId") orderId: string): Promise<DispatchView | { status: null }> {
    return (await this.dispatch.byOrder(currentTenant(), orderId)) ?? { status: null };
  }

  @Get("driver/dispatch")
  @Roles(ROLES.DRIVER)
  async forDriver(@Query("driverId") driverId: string): Promise<DispatchView | { status: null }> {
    return (await this.dispatch.forDriver(currentTenant(), driverId)) ?? { status: null };
  }
}
