import { buildEnvelope } from "@flashbite/shared";
import { EVENT_TYPES } from "@flashbite/contracts";
import { toStreamEvent, toDispatchView } from "../src/sse/sse-feeder.service";

describe("toStreamEvent", () => {
  it("maps an OrderPlaced envelope to {orderId, eventType, status} without a cancelReason", () => {
    const env = buildEnvelope({
      tenantId: "berlin", eventType: EVENT_TYPES.ORDER_PLACED, version: 1,
      payload: { orderId: "o-1", customerId: "c", items: [], totalAmount: 0 },
    });
    const ev = toStreamEvent(env);
    expect(ev.orderId).toBe("o-1");
    expect(ev.eventType).toBe(EVENT_TYPES.ORDER_PLACED);
    expect(ev.cancelReason).toBeUndefined();
  });

  it("includes cancelReason on an OrderCancelled envelope", () => {
    const env = buildEnvelope({
      tenantId: "berlin", eventType: EVENT_TYPES.ORDER_CANCELLED, version: 2,
      payload: { orderId: "o-1", reason: "DECLINED" },
    });
    const ev = toStreamEvent(env);
    expect(ev.orderId).toBe("o-1");
    expect(ev.eventType).toBe(EVENT_TYPES.ORDER_CANCELLED);
    expect(ev.cancelReason).toBe("DECLINED");
  });
});

describe("toDispatchView", () => {
  const base = { tenantId: "berlin", version: 3, occurredAt: "2026-06-21T00:00:00.000Z" };
  it("maps DriverOffered -> OFFERED with offeredDriverId", () => {
    const v = toDispatchView({ ...base, eventType: EVENT_TYPES.DRIVER_OFFERED, payload: { orderId: "o-1", driverId: "drv-1" } } as never);
    expect(v).toMatchObject({ orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 3 });
  });
  it("stamps offerExpiresAt = occurredAt + offerTimeoutSeconds on an OFFERED view", () => {
    const v = toDispatchView({ ...base, eventType: EVENT_TYPES.DRIVER_OFFERED, payload: { orderId: "o-1", driverId: "drv-1" } } as never, 60);
    expect(v?.offerExpiresAt).toBe("2026-06-21T00:01:00.000Z");
  });
  it("maps DispatchAccepted -> DISPATCHED with driverId", () => {
    const v = toDispatchView({ ...base, eventType: EVENT_TYPES.DISPATCH_ACCEPTED, payload: { orderId: "o-1", driverId: "drv-1" } } as never);
    expect(v).toMatchObject({ status: "DISPATCHED", driverId: "drv-1" });
  });
  it("maps OrderPickedUp/OrderDelivered -> PICKED_UP/DELIVERED", () => {
    expect(toDispatchView({ ...base, eventType: EVENT_TYPES.ORDER_PICKED_UP, payload: { orderId: "o-1" } } as never)?.status).toBe("PICKED_UP");
    expect(toDispatchView({ ...base, eventType: EVENT_TYPES.ORDER_DELIVERED, payload: { orderId: "o-1" } } as never)?.status).toBe("DELIVERED");
  });
  it("maps DispatchFailed -> FAILED with reason", () => {
    const v = toDispatchView({ ...base, eventType: EVENT_TYPES.DISPATCH_FAILED, payload: { orderId: "o-1", reason: "NO_DRIVERS_AVAILABLE" } } as never);
    expect(v).toMatchObject({ status: "FAILED", reason: "NO_DRIVERS_AVAILABLE" });
  });
  it("returns null for an unrelated event type", () => {
    expect(toDispatchView({ ...base, eventType: "OrderPlaced", payload: { orderId: "o-1" } } as never)).toBeNull();
  });
});
