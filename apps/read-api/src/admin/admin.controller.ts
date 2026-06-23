import { Controller, Get, Sse, UseGuards } from "@nestjs/common";
import { Observable, from, merge } from "rxjs";
import { map, mergeMap } from "rxjs/operators";
import { Roles, RolesGuard } from "@flashbite/tenant-context";
import { ROLES, type OrderView } from "@flashbite/contracts";
import { TenantCatalogService } from "@flashbite/shared";
import { AdminService, type TenantNearbyDriver } from "./admin.service";
import { OrderStreamService } from "../sse/order-stream.service";

interface MessageEvent { data: unknown; }

@Controller("admin")
@UseGuards(RolesGuard)
@Roles(ROLES.OPERATOR)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly stream: OrderStreamService,
    private readonly catalog: TenantCatalogService,
  ) {}

  @Get("orders")
  listOrders(): Promise<OrderView[]> { return this.admin.listAllOrders(); }

  @Get("drivers")
  listDrivers(): Promise<TenantNearbyDriver[]> { return this.admin.listAllDrivers(); }

  @Sse("orders/stream")
  ordersStream(): Observable<MessageEvent> {
    return from(this.catalog.list()).pipe(
      mergeMap((tenants) =>
        merge(...tenants.map(({ slug: tenantId }) =>
          this.stream.stream(tenantId).pipe(map((event) => ({ data: { tenantId, ...event } }))),
        )),
      ),
    );
  }
}
