import { Controller, Get, Sse, UseGuards } from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { Roles, RolesGuard } from "@flashbite/tenant-context";
import { ROLES } from "@flashbite/contracts";
import { currentTenant } from "../tenant-scope";
import { DispatchStreamService } from "./dispatch-stream.service";
import { DispatchQueryService } from "../dispatch/dispatch-query.service";
import { toDeliveryView, type DeliveryView } from "../dispatch/delivery-view";

interface MessageEvent {
  data: unknown;
}

@Controller("merchant/dispatch")
@UseGuards(RolesGuard)
export class MerchantDispatchSseController {
  constructor(
    private readonly stream: DispatchStreamService,
    private readonly dispatch: DispatchQueryService,
  ) {}

  /** Snapshot of every order's current delivery state for the tenant (driver identity stripped).
   *  Seeds the merchant dispatch map on load; the SSE below then carries live updates. */
  @Get()
  @Roles(ROLES.MERCHANT)
  async snapshot(): Promise<DeliveryView[]> {
    const all = await this.dispatch.allForTenant(currentTenant());
    return all.map(toDeliveryView);
  }

  @Sse("stream")
  @Roles(ROLES.MERCHANT)
  dispatchStream(): Observable<MessageEvent> {
    const tenantId = currentTenant();
    // Whole-tenant dispatch updates (no per-driver filter) — the merchant view tracks every order.
    return this.stream.stream(tenantId).pipe(map((view) => ({ data: toDeliveryView(view) })));
  }
}
