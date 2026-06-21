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

/** True when a dispatch view concerns this driver — either an offer made to them
 *  or an active job assigned to them. Exported for tests. */
export function isForDriver(view: DispatchView, driverId: string): boolean {
  return view.offeredDriverId === driverId || view.driverId === driverId;
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
    // Initial snapshot (current offer/job, if any) then the live, per-driver-filtered tail.
    const snapshot$ = defer(() => from(this.dispatch.forDriver(tenantId, driverId))).pipe(
      filter((v): v is DispatchView => v != null),
    );
    const live$ = this.stream.stream(tenantId).pipe(filter((v) => isForDriver(v, driverId)));
    return concat(snapshot$, live$).pipe(map((view) => ({ data: view })));
  }
}
