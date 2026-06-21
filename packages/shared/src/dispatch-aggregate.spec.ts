import {
  foldDispatch, offer, acceptOffer, pickup, deliver, fail,
  INITIAL_DISPATCH_STATE, InvalidTransitionError,
} from "./dispatch-aggregate";
import { EVENT_TYPES, DISPATCH_STATUS } from "@flashbite/contracts";

const ev = (eventType: string, payload: unknown) => ({ eventType, payload, version: 1 });

describe("dispatch-aggregate", () => {
  it("folds the happy path to DELIVERED", () => {
    let s = INITIAL_DISPATCH_STATE;
    s = foldDispatch(s, ev(EVENT_TYPES.DRIVER_OFFERED, { orderId: "o1", driverId: "d1" }));
    expect(s.status).toBe(DISPATCH_STATUS.OFFERED);
    expect(s.offeredDriverId).toBe("d1");
    s = foldDispatch(s, ev(EVENT_TYPES.DISPATCH_ACCEPTED, { orderId: "o1", driverId: "d1" }));
    expect(s.status).toBe(DISPATCH_STATUS.DISPATCHED);
    expect(s.driverId).toBe("d1");
    s = foldDispatch(s, ev(EVENT_TYPES.ORDER_PICKED_UP, { orderId: "o1" }));
    expect(s.status).toBe(DISPATCH_STATUS.PICKED_UP);
    s = foldDispatch(s, ev(EVENT_TYPES.ORDER_DELIVERED, { orderId: "o1" }));
    expect(s.status).toBe(DISPATCH_STATUS.DELIVERED);
  });

  it("offer is allowed from null and from OFFERED (re-offer)", () => {
    expect(offer(INITIAL_DISPATCH_STATE, "o1", "d1")).toEqual({ orderId: "o1", driverId: "d1" });
    const offered = foldDispatch(INITIAL_DISPATCH_STATE, ev(EVENT_TYPES.DRIVER_OFFERED, { orderId: "o1", driverId: "d1" }));
    expect(offer(offered, "o1", "d2")).toEqual({ orderId: "o1", driverId: "d2" });
  });

  it("acceptOffer requires OFFERED and matching driver", () => {
    const offered = foldDispatch(INITIAL_DISPATCH_STATE, ev(EVENT_TYPES.DRIVER_OFFERED, { orderId: "o1", driverId: "d1" }));
    expect(acceptOffer(offered, "o1", "d1")).toEqual({ orderId: "o1", driverId: "d1" });
    expect(() => acceptOffer(offered, "o1", "dX")).toThrow(InvalidTransitionError);
    expect(() => acceptOffer(INITIAL_DISPATCH_STATE, "o1", "d1")).toThrow(InvalidTransitionError);
  });

  it("pickup requires DISPATCHED; deliver requires PICKED_UP", () => {
    let s = foldDispatch(INITIAL_DISPATCH_STATE, ev(EVENT_TYPES.DRIVER_OFFERED, { orderId: "o1", driverId: "d1" }));
    s = foldDispatch(s, ev(EVENT_TYPES.DISPATCH_ACCEPTED, { orderId: "o1", driverId: "d1" }));
    expect(pickup(s, "o1")).toEqual({ orderId: "o1" });
    expect(() => deliver(s, "o1")).toThrow(InvalidTransitionError);
    s = foldDispatch(s, ev(EVENT_TYPES.ORDER_PICKED_UP, { orderId: "o1" }));
    expect(deliver(s, "o1")).toEqual({ orderId: "o1" });
  });

  it("fail is allowed while not yet terminal", () => {
    expect(fail(INITIAL_DISPATCH_STATE, "o1", "NO_DRIVERS_AVAILABLE")).toEqual({ orderId: "o1", reason: "NO_DRIVERS_AVAILABLE" });
    let s = foldDispatch(INITIAL_DISPATCH_STATE, ev(EVENT_TYPES.DRIVER_OFFERED, { orderId: "o1", driverId: "d1" }));
    s = foldDispatch(s, ev(EVENT_TYPES.DISPATCH_ACCEPTED, { orderId: "o1", driverId: "d1" }));
    s = foldDispatch(s, ev(EVENT_TYPES.ORDER_PICKED_UP, { orderId: "o1" }));
    s = foldDispatch(s, ev(EVENT_TYPES.ORDER_DELIVERED, { orderId: "o1" }));
    expect(() => fail(s, "o1", "x")).toThrow(InvalidTransitionError);
  });
});
