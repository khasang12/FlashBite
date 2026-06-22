import { describe, it, expect } from "vitest";
import { dispatchStatusLabel, DISPATCH_OFFER_TIMEOUT_SECONDS, deliveryStatusLabel } from "./labels";

describe("dispatchStatusLabel", () => {
  it("maps each dispatch status to a driver-facing label", () => {
    expect(dispatchStatusLabel("OFFERED")).toBe("New offer");
    expect(dispatchStatusLabel("DISPATCHED")).toBe("Accepted — head to pickup");
    expect(dispatchStatusLabel("PICKED_UP")).toBe("Picked up — deliver");
    expect(dispatchStatusLabel("DELIVERED")).toBe("Delivered");
    expect(dispatchStatusLabel("FAILED")).toBe("No longer available");
  });
  it("falls back to the raw status for an unknown value", () => {
    expect(dispatchStatusLabel("WAT")).toBe("WAT");
  });
});

describe("DISPATCH_OFFER_TIMEOUT_SECONDS", () => {
  it("is the display default matching the saga (30s)", () => {
    expect(DISPATCH_OFFER_TIMEOUT_SECONDS).toBe(30);
  });
});

describe("deliveryStatusLabel", () => {
  it("maps each dispatch status to outward-facing copy", () => {
    expect(deliveryStatusLabel("OFFERED")).toBe("Finding a driver");
    expect(deliveryStatusLabel("DISPATCHED")).toBe("Driver assigned");
    expect(deliveryStatusLabel("PICKED_UP")).toBe("Out for delivery");
    expect(deliveryStatusLabel("DELIVERED")).toBe("Delivered");
    expect(deliveryStatusLabel("FAILED")).toBe("Delivery unavailable");
  });
  it("passes through an unknown status", () => {
    expect(deliveryStatusLabel("WAT")).toBe("WAT");
  });
});
