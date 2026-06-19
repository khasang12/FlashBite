import {
  foldOrder, place, accept, cancel, INITIAL_ORDER_STATE, InvalidTransitionError,
} from "./order-aggregate";
import { EVENT_TYPES, ORDER_STATUS } from "@flashbite/contracts";

const placed = (over = {}) => ({ orderId: "o-1", customerId: "c-1", items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200, ...over });

describe("order aggregate", () => {
  describe("foldOrder", () => {
    it("folds OrderPlaced into PLACED state", () => {
      const s = foldOrder(INITIAL_ORDER_STATE, { eventType: EVENT_TYPES.ORDER_PLACED, payload: placed() });
      expect(s).toMatchObject({ status: ORDER_STATUS.PLACED, customerId: "c-1", totalAmount: 1200 });
    });
    it("folds OrderAccepted / OrderCancelled", () => {
      const s = foldOrder(INITIAL_ORDER_STATE, { eventType: EVENT_TYPES.ORDER_PLACED, payload: placed() });
      expect(foldOrder(s, { eventType: EVENT_TYPES.ORDER_ACCEPTED, payload: { orderId: "o-1" } }).status).toBe(ORDER_STATUS.ACCEPTED);
      const c = foldOrder(s, { eventType: EVENT_TYPES.ORDER_CANCELLED, payload: { orderId: "o-1", reason: "SLA_BREACH" } });
      expect(c.status).toBe(ORDER_STATUS.CANCELLED);
      expect(c.cancelReason).toBe("SLA_BREACH");
    });
    it("ignores unknown events", () => {
      expect(foldOrder(INITIAL_ORDER_STATE, { eventType: "Whatever", payload: {} })).toEqual(INITIAL_ORDER_STATE);
    });
  });

  describe("commands", () => {
    const placedState = foldOrder(INITIAL_ORDER_STATE, { eventType: EVENT_TYPES.ORDER_PLACED, payload: placed() });
    it("place on a new order returns the payload", () => {
      expect(place(INITIAL_ORDER_STATE, placed())).toEqual(placed());
    });
    it("place on an existing order is idempotent (null)", () => {
      expect(place(placedState, placed())).toBeNull();
    });
    it("accept a PLACED order returns OrderAccepted payload", () => {
      expect(accept(placedState, "o-1")).toEqual({ orderId: "o-1" });
    });
    it("accept/cancel a terminal order throws InvalidTransitionError", () => {
      const accepted = foldOrder(placedState, { eventType: EVENT_TYPES.ORDER_ACCEPTED, payload: { orderId: "o-1" } });
      expect(() => accept(accepted, "o-1")).toThrow(InvalidTransitionError);
      expect(() => cancel(accepted, "o-1", "DECLINED")).toThrow(InvalidTransitionError);
    });
    it("cancel a PLACED order returns OrderCancelled payload", () => {
      expect(cancel(placedState, "o-1", "DECLINED")).toEqual({ orderId: "o-1", reason: "DECLINED" });
    });
  });
});
