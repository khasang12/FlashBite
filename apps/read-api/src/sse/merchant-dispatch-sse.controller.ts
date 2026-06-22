import { Controller, Sse, UseGuards } from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { Roles, RolesGuard } from "@flashbite/tenant-context";
import { ROLES } from "@flashbite/contracts";
import { currentTenant } from "../tenant-scope";
import { DispatchStreamService } from "./dispatch-stream.service";
import { toDeliveryView } from "../dispatch/delivery-view";

interface MessageEvent {
  data: unknown;
}

@Controller("merchant/dispatch")
@UseGuards(RolesGuard)
export class MerchantDispatchSseController {
  constructor(private readonly stream: DispatchStreamService) {}

  @Sse("stream")
  @Roles(ROLES.MERCHANT)
  dispatchStream(): Observable<MessageEvent> {
    const tenantId = currentTenant();
    // Whole-tenant dispatch updates (no per-driver filter) — the merchant view tracks every order.
    return this.stream.stream(tenantId).pipe(map((view) => ({ data: toDeliveryView(view) })));
  }
}
