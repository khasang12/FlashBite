import { buildEnvelope } from "@flashbite/shared";
import { EVENT_TYPES } from "@flashbite/contracts";
import { toStreamEvent } from "../src/sse/sse-feeder.service";

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
