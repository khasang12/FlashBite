import { firstValueFrom } from "rxjs";
import { take, toArray } from "rxjs/operators";
import { runWithAuth } from "@flashbite/tenant-context";
import { DispatchStreamService } from "../src/sse/dispatch-stream.service";
import { MerchantDispatchSseController } from "../src/sse/merchant-dispatch-sse.controller";
import type { DispatchView } from "@flashbite/contracts";

const view = (over: Partial<DispatchView> = {}): DispatchView => ({
  tenantId: "berlin", orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 1, updatedAt: "t", ...over,
});

describe("MerchantDispatchSseController", () => {
  it("streams the tenant's dispatch views as { data } for the current tenant", async () => {
    const svc = new DispatchStreamService();
    const ctrl = new MerchantDispatchSseController(svc);
    const collected = runWithAuth({ tenantId: "berlin", role: "merchant", sub: "m-1" }, () =>
      firstValueFrom(ctrl.dispatchStream().pipe(take(2), toArray())),
    );
    svc.publish("berlin", view());
    svc.publish("berlin", view({ status: "DISPATCHED", driverId: "drv-1", version: 2 }));
    const got = await collected;
    expect(got.map((m) => (m.data as DispatchView).status)).toEqual(["OFFERED", "DISPATCHED"]);
  });

  it("does not stream another tenant's dispatch views", async () => {
    const svc = new DispatchStreamService();
    const ctrl = new MerchantDispatchSseController(svc);
    const seen: unknown[] = [];
    runWithAuth({ tenantId: "berlin", role: "merchant", sub: "m-1" }, () => {
      ctrl.dispatchStream().subscribe((m) => seen.push(m));
    });
    svc.publish("tokyo", view({ tenantId: "tokyo" }));
    expect(seen).toEqual([]);
  });
});
