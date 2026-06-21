import { describe, it, expect } from "vitest";
import { parseDispatchData, reduceDispatch } from "./use-dispatch-stream";
import type { DispatchView } from "@flashbite/contracts";

const view = (over: Partial<DispatchView> = {}): DispatchView => ({
  tenantId: "berlin", orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 1, updatedAt: "t1", ...over,
});

describe("parseDispatchData", () => {
  it("parses a well-formed dispatch view", () => {
    expect(parseDispatchData(JSON.stringify(view()))).toEqual(view());
  });
  it("returns null for malformed JSON", () => {
    expect(parseDispatchData("nope")).toBeNull();
  });
  it("returns null when orderId or status is missing", () => {
    expect(parseDispatchData(JSON.stringify({ orderId: "o-1" }))).toBeNull();
    expect(parseDispatchData(JSON.stringify({ status: "OFFERED" }))).toBeNull();
  });
});

describe("reduceDispatch", () => {
  it("takes the incoming view when there is none", () => {
    expect(reduceDispatch(null, view())).toEqual(view());
  });
  it("advances to a newer version of the same order", () => {
    const next = view({ status: "DISPATCHED", driverId: "drv-1", version: 2, updatedAt: "t2" });
    expect(reduceDispatch(view(), next)).toEqual(next);
  });
  it("ignores a stale (older-version) event for the same order", () => {
    const prev = view({ status: "DISPATCHED", version: 2 });
    expect(reduceDispatch(prev, view({ version: 1 }))).toEqual(prev);
  });
  it("switches to a different order regardless of version", () => {
    const other = view({ orderId: "o-2", version: 1 });
    expect(reduceDispatch(view({ version: 5 }), other)).toEqual(other);
  });
});
