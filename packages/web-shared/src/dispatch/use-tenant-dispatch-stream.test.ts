import { describe, it, expect } from "vitest";
import { reduceDispatchMap } from "./use-tenant-dispatch-stream";
import type { DispatchView } from "@flashbite/contracts";

const view = (over: Partial<DispatchView> = {}): DispatchView => ({
  tenantId: "berlin", orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 1, updatedAt: "t", ...over,
});

describe("reduceDispatchMap", () => {
  it("adds a new order's view keyed by orderId", () => {
    const out = reduceDispatchMap({}, view());
    expect(out["o-1"].status).toBe("OFFERED");
  });
  it("advances an existing order on a newer version", () => {
    const prev = { "o-1": view({ version: 1 }) };
    const out = reduceDispatchMap(prev, view({ status: "DISPATCHED", driverId: "drv-1", version: 2 }));
    expect(out["o-1"].status).toBe("DISPATCHED");
  });
  it("ignores a stale (older-version) event for an order", () => {
    const prev = { "o-1": view({ status: "DISPATCHED", version: 2 }) };
    const out = reduceDispatchMap(prev, view({ version: 1 }));
    expect(out["o-1"].status).toBe("DISPATCHED");
  });
  it("keeps other orders untouched", () => {
    const prev = { "o-2": view({ orderId: "o-2" }) };
    const out = reduceDispatchMap(prev, view({ orderId: "o-1" }));
    expect(Object.keys(out).sort()).toEqual(["o-1", "o-2"]);
  });
});
