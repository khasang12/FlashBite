import { firstValueFrom } from "rxjs";
import { take, toArray } from "rxjs/operators";
import { DispatchStreamService } from "../src/sse/dispatch-stream.service";
import { isForDriver } from "../src/sse/driver-sse.controller";
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
