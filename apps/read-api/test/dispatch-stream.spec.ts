import { firstValueFrom } from "rxjs";
import { take, toArray } from "rxjs/operators";
import { DispatchStreamService } from "../src/sse/dispatch-stream.service";
import { isForDriver, acceptForDriver } from "../src/sse/driver-sse.controller";
import type { DispatchView } from "@flashbite/contracts";

const view = (over: Partial<DispatchView> = {}): DispatchView => ({
  tenantId: "berlin", orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 1, updatedAt: "t", ...over,
});

describe("DispatchStreamService", () => {
  it("delivers published views to a tenant subscriber", async () => {
    const svc = new DispatchStreamService();
    const collected = firstValueFrom(svc.stream("berlin").pipe(take(2), toArray()));
    svc.publish("berlin", view());
    svc.publish("berlin", view({ status: "DISPATCHED", driverId: "drv-1", version: 2 }));
    const got = await collected;
    expect(got.map((v) => v.status)).toEqual(["OFFERED", "DISPATCHED"]);
  });

  it("isolates tenants — a berlin subscriber never sees tokyo events", async () => {
    const svc = new DispatchStreamService();
    const berlin: DispatchView[] = [];
    svc.stream("berlin").subscribe((v) => berlin.push(v));
    svc.publish("tokyo", view({ tenantId: "tokyo" }));
    expect(berlin).toEqual([]);
  });
});

describe("isForDriver", () => {
  it("matches an offer targeted at the driver", () => {
    expect(isForDriver(view({ status: "OFFERED", offeredDriverId: "drv-1" }), "drv-1")).toBe(true);
  });
  it("matches an active job assigned to the driver", () => {
    expect(isForDriver(view({ status: "DISPATCHED", driverId: "drv-1", offeredDriverId: undefined }), "drv-1")).toBe(true);
  });
  it("rejects another driver's offer/job", () => {
    expect(isForDriver(view({ status: "OFFERED", offeredDriverId: "drv-2" }), "drv-1")).toBe(false);
    expect(isForDriver(view({ status: "DISPATCHED", driverId: "drv-2", offeredDriverId: undefined }), "drv-1")).toBe(false);
  });
});

describe("acceptForDriver (per-connection owned-order tracking)", () => {
  it("emits and tracks a job assigned to the driver, then emits its follow-up events", () => {
    const owned = new Set<string>();
    expect(acceptForDriver(owned, view({ status: "DISPATCHED", driverId: "drv-1", offeredDriverId: undefined }), "drv-1")).toBe(true);
    // follow-up PICKED_UP / DELIVERED carry no driver id but share the owned orderId
    expect(acceptForDriver(owned, view({ status: "PICKED_UP", driverId: undefined, offeredDriverId: undefined }), "drv-1")).toBe(true);
    expect(acceptForDriver(owned, view({ status: "DELIVERED", driverId: undefined, offeredDriverId: undefined }), "drv-1")).toBe(true);
  });
  it("emits an offer to the driver but does NOT start tracking it (offer may go to someone else)", () => {
    const owned = new Set<string>();
    expect(acceptForDriver(owned, view({ status: "OFFERED", offeredDriverId: "drv-1" }), "drv-1")).toBe(true);
    // a later event for that same order assigned to ANOTHER driver must not leak to drv-1
    expect(acceptForDriver(owned, view({ status: "DISPATCHED", driverId: "drv-2", offeredDriverId: undefined }), "drv-1")).toBe(false);
    expect(acceptForDriver(owned, view({ status: "PICKED_UP", driverId: undefined, offeredDriverId: undefined }), "drv-1")).toBe(false);
  });
  it("does not emit another driver's job or its follow-ups", () => {
    const owned = new Set<string>();
    expect(acceptForDriver(owned, view({ status: "DISPATCHED", driverId: "drv-2", offeredDriverId: undefined }), "drv-1")).toBe(false);
    expect(acceptForDriver(owned, view({ status: "DELIVERED", driverId: undefined, offeredDriverId: undefined }), "drv-1")).toBe(false);
  });
});
