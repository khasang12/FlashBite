import { runWithAuth } from "@flashbite/tenant-context";
import { DISPATCH_STATUS, driverGeoKey } from "@flashbite/contracts";
import { driverLocationVisible } from "../src/dispatch/driver-location";
import { DispatchController } from "../src/dispatch/dispatch.controller";

describe("driverLocationVisible", () => {
  it("is true only while the driver is en route (DISPATCHED/PICKED_UP)", () => {
    expect(driverLocationVisible(DISPATCH_STATUS.DISPATCHED)).toBe(true);
    expect(driverLocationVisible(DISPATCH_STATUS.PICKED_UP)).toBe(true);
    expect(driverLocationVisible(DISPATCH_STATUS.OFFERED)).toBe(false);
    expect(driverLocationVisible(DISPATCH_STATUS.DELIVERED)).toBe(false);
    expect(driverLocationVisible(DISPATCH_STATUS.FAILED)).toBe(false);
    expect(driverLocationVisible("WAT")).toBe(false);
  });
});

describe("DispatchController.driverLocation", () => {
  const ctx = { tenantId: "berlin", role: "customer", sub: "c-1" };

  it("returns {lng,lat} and NO driverId for an en-route order", async () => {
    const dispatch = { byOrder: async () => ({ status: "DISPATCHED", driverId: "drv-1", orderId: "o-1" }) } as never;
    const geopos = jest.fn(async () => [["13.4", "52.5"]]);
    const redis = { cluster: { geopos } } as never;
    const ctrl = new DispatchController(dispatch, redis);
    const res = await runWithAuth(ctx, () => ctrl.driverLocation("o-1"));
    expect(res).toEqual({ location: { lng: 13.4, lat: 52.5 } });
    expect((res as Record<string, unknown>).driverId).toBeUndefined();
    expect(geopos).toHaveBeenCalledWith(driverGeoKey("berlin"), "drv-1");
  });

  it("returns {location:null} and does not query Redis when not en route", async () => {
    const dispatch = { byOrder: async () => ({ status: "DELIVERED", driverId: "drv-1", orderId: "o-1" }) } as never;
    const geopos = jest.fn(async () => [["1", "2"]]);
    const ctrl = new DispatchController(dispatch, { cluster: { geopos } } as never);
    const res = await runWithAuth(ctx, () => ctrl.driverLocation("o-1"));
    expect(res).toEqual({ location: null });
    expect(geopos).not.toHaveBeenCalled();
  });

  it("returns {location:null} when the driver has no geo position yet", async () => {
    const dispatch = { byOrder: async () => ({ status: "PICKED_UP", driverId: "drv-1", orderId: "o-1" }) } as never;
    const ctrl = new DispatchController(dispatch, { cluster: { geopos: async () => [null] } } as never);
    const res = await runWithAuth(ctx, () => ctrl.driverLocation("o-1"));
    expect(res).toEqual({ location: null });
  });
});
