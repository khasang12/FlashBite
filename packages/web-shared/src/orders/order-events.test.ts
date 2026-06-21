import { describe, it, expect } from "vitest";
import { statusFromEventType, applyOrderEvent, upsertOrder, cancelReasonLabel } from "./order-events";
import type { OrderView } from "@flashbite/contracts";

const ov = (orderId: string, status: string, updatedAt: string): OrderView => ({
  tenantId: "berlin", orderId, customerId: "a", items: [], totalAmount: 0, status, version: 1, updatedAt,
});

describe("order-events", () => {
  it("maps event types to statuses", () => {
    expect(statusFromEventType("OrderPlaced")).toBe("PLACED");
    expect(statusFromEventType("OrderAccepted")).toBe("ACCEPTED");
    expect(statusFromEventType("OrderCancelled")).toBe("CANCELLED");
    expect(statusFromEventType("Nonsense")).toBeNull();
  });

  it("upsertOrder replaces by orderId and keeps newest-first", () => {
    const rows = [ov("a", "PLACED", "2026-06-14T10:00:00Z")];
    const next = upsertOrder(rows, ov("b", "PLACED", "2026-06-14T11:00:00Z"));
    expect(next.map((r) => r.orderId)).toEqual(["b", "a"]);
    const replaced = upsertOrder(next, ov("a", "ACCEPTED", "2026-06-14T12:00:00Z"));
    expect(replaced.find((r) => r.orderId === "a")?.status).toBe("ACCEPTED");
    expect(replaced).toHaveLength(2);
  });

  it("applyOrderEvent updates an existing row's status in place", () => {
    const rows = [ov("a", "PLACED", "2026-06-14T10:00:00Z")];
    const next = applyOrderEvent(rows, { orderId: "a", eventType: "OrderAccepted" });
    expect(next.find((r) => r.orderId === "a")?.status).toBe("ACCEPTED");
  });

  it("applyOrderEvent leaves rows unchanged for an unknown order (caller fetches detail)", () => {
    const rows = [ov("a", "PLACED", "2026-06-14T10:00:00Z")];
    const next = applyOrderEvent(rows, { orderId: "z", eventType: "OrderPlaced" });
    expect(next).toEqual(rows);
  });

  it("applyOrderEvent leaves a known order unchanged for an unmappable event type", () => {
    const rows = [ov("a", "PLACED", "2026-06-14T10:00:00Z")];
    const next = applyOrderEvent(rows, { orderId: "a", eventType: "SomethingElse" });
    expect(next).toBe(rows);
  });
});

const row = (over: Partial<OrderView> = {}): OrderView => ({
  tenantId: "berlin", orderId: "o-1", customerId: "c", items: [], totalAmount: 100,
  status: "PLACED", version: 1, updatedAt: "t", ...over,
});

describe("applyOrderEvent cancelReason", () => {
  it("sets status + cancelReason on a known order when the event carries a reason", () => {
    const out = applyOrderEvent([row()], { orderId: "o-1", eventType: "OrderCancelled", cancelReason: "SLA_BREACH" });
    expect(out[0].status).toBe("CANCELLED");
    expect(out[0].cancelReason).toBe("SLA_BREACH");
  });

  it("leaves cancelReason unset for non-cancel events", () => {
    const out = applyOrderEvent([row()], { orderId: "o-1", eventType: "OrderAccepted" });
    expect(out[0].status).toBe("ACCEPTED");
    expect(out[0].cancelReason).toBeUndefined();
  });
});

describe("cancelReasonLabel", () => {
  it("returns human-readable label for PAYMENT_FAILED", () => {
    expect(cancelReasonLabel("PAYMENT_FAILED")).toBe("Payment failed");
  });

  it("returns human-readable labels for existing reasons", () => {
    expect(cancelReasonLabel("SLA_BREACH")).toBe("SLA breach");
    expect(cancelReasonLabel("DECLINED")).toBe("Declined by merchant");
  });

  it("falls back to the raw reason for unknown values", () => {
    expect(cancelReasonLabel("UNKNOWN_REASON")).toBe("UNKNOWN_REASON");
  });

  it("returns empty string for undefined", () => {
    expect(cancelReasonLabel(undefined)).toBe("");
  });
});
