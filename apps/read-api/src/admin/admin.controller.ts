import { Controller, Get, Sse, UseGuards } from "@nestjs/common";
import { Observable, merge } from "rxjs";
import { map } from "rxjs/operators";
import { Roles, RolesGuard } from "@flashbite/tenant-context";
import { TENANTS, type OrderView } from "@flashbite/contracts";
import { AdminService, type TenantNearbyDriver } from "./admin.service";
import { OrderStreamService } from "../sse/order-stream.service";

interface MessageEvent {
  data: unknown;
}

@Controller("admin")
@UseGuards(RolesGuard)
@Roles("operator")
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly stream: OrderStreamService,
  ) {}

  @Get("orders")
  listOrders(): Promise<OrderView[]> {
    return this.admin.listAllOrders();
  }

  @Get("drivers")
  listDrivers(): Promise<TenantNearbyDriver[]> {
    return this.admin.listAllDrivers();
  }

  @Sse("orders/stream")
  ordersStream(): Observable<MessageEvent> {
    const streams = TENANTS.map((tenantId) =>
      this.stream.stream(tenantId).pipe(map((event) => ({ data: { tenantId, ...event } }))),
    );
    return merge(...streams);
  }
}
