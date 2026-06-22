import { Controller, Sse, UseGuards } from "@nestjs/common";
import { Observable, concat, defer, from } from "rxjs";
import { filter, map } from "rxjs/operators";
import { Roles, RolesGuard } from "@flashbite/tenant-context";
import { ROLES, type DispatchView } from "@flashbite/contracts";
import { currentTenant, currentSub } from "../tenant-scope";
import { DispatchQueryService } from "../dispatch/dispatch-query.service";
import { DispatchStreamService } from "./dispatch-stream.service";

interface MessageEvent {
  data: unknown;
}

/** True when a dispatch view is directly this driver's — an offer made to them or a job
 *  assigned to them. Exported for tests. */
export function isForDriver(view: DispatchView, driverId: string): boolean {
  return view.offeredDriverId === driverId || view.driverId === driverId;
}

/** Per-connection emit decision. Tracks orders assigned to this driver so that follow-up
 *  events (OrderPickedUp/OrderDelivered/DispatchFailed) — which carry no driver id — still
 *  reach the driver who owns the order. Mutates `owned`. Exported for tests. */
export function acceptForDriver(owned: Set<string>, view: DispatchView, driverId: string): boolean {
  if (view.driverId === driverId) owned.add(view.orderId);
  return isForDriver(view, driverId) || owned.has(view.orderId);
}

@Controller()
@UseGuards(RolesGuard)
export class DriverSseController {
  constructor(
    private readonly dispatch: DispatchQueryService,
    private readonly stream: DispatchStreamService,
  ) {}

  @Sse("driver/dispatch/stream")
  @Roles(ROLES.DRIVER)
  driverStream(): Observable<MessageEvent> {
    const tenantId = currentTenant();
    const driverId = currentSub();
    const owned = new Set<string>();
    // Snapshot first (current offer/job), then the live, per-driver tail. Follow-up terminal
    // events carry no driver id, so they're matched via the owned-order set and stamped with
    // driverId so downstream consumers can attribute them.
    const snapshot$ = from(defer(() => this.dispatch.forDriver(tenantId, driverId))).pipe(
      filter((v): v is DispatchView => v != null),
    );
    const live$ = this.stream.stream(tenantId);
    return concat(snapshot$, live$).pipe(
      filter((v) => acceptForDriver(owned, v, driverId)),
      map((v) => ({ data: v.driverId ? v : { ...v, driverId } })),
    );
  }
}
