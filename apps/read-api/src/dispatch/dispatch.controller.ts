import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { Roles, RolesGuard } from "@flashbite/tenant-context";
import { RedisService } from "@flashbite/shared";
import { ROLES, driverGeoKey, type DispatchView } from "@flashbite/contracts";
import { currentTenant } from "../tenant-scope";
import { DispatchQueryService } from "./dispatch-query.service";
import { toDeliveryView, type DeliveryView } from "./delivery-view";
import { driverLocationVisible, type DriverLocation } from "./driver-location";

@Controller()
@UseGuards(RolesGuard)
export class DispatchController {
  constructor(
    private readonly dispatch: DispatchQueryService,
    private readonly redis: RedisService,
  ) {}

  @Get("orders/:orderId/dispatch")
  async byOrder(@Param("orderId") orderId: string): Promise<DeliveryView | { status: null }> {
    const v = await this.dispatch.byOrder(currentTenant(), orderId);
    return v ? toDeliveryView(v) : { status: null };
  }

  @Get("driver/dispatch")
  @Roles(ROLES.DRIVER)
  async forDriver(@Query("driverId") driverId: string): Promise<DispatchView | { status: null }> {
    return (await this.dispatch.forDriver(currentTenant(), driverId)) ?? { status: null };
  }

  @Get("orders/:orderId/driver-location")
  async driverLocation(@Param("orderId") orderId: string): Promise<{ location: DriverLocation | null }> {
    const d = await this.dispatch.byOrder(currentTenant(), orderId);
    if (!d || !d.driverId || !driverLocationVisible(d.status)) return { location: null };
    const pos = (await this.redis.cluster.geopos(driverGeoKey(currentTenant()), d.driverId)) as Array<[string, string] | null>;
    const p = pos?.[0];
    if (!p) return { location: null };
    return { location: { lng: Number(p[0]), lat: Number(p[1]) } };
  }
}
