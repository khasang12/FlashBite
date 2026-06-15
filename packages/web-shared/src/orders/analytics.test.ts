import { describe, it, expect } from "vitest";
import {
  aggregateGmv, gmvByTenant, statusBreakdown, topSkus, gmvOverTime, orderCounts, replaceTenantOrders,
} from "./analytics";
import type { OrderView } from "@flashbite/contracts";

const o = (over: Partial<OrderView>): OrderView => ({
  tenantId: "berlin", orderId: Math.random().toString(36).slice(2), customerId: "c",
  items: [{ sku: "pizza", qty: 1, price: 1000 }], totalAmount: 1000,
  status: "PLACED", version: 1, updatedAt: "2026-06-14T10:00:00.000Z", ...over,
});

const orders: OrderView[] = [
  o({ tenantId: "berlin", totalAmount: 1000, status: "ACCEPTED", items: [{ sku: "pizza", qty: 2, price: 500 }], updatedAt: "2026-06-14T10:15:00.000Z" }),
  o({ tenantId: "berlin", totalAmount: 500, status: "PLACED", items: [{ sku: "burger", qty: 1, price: 500 }], updatedAt: "2026-06-14T11:30:00.000Z" }),
  o({ tenantId: "berlin", totalAmount: 9999, status: "CANCELLED", cancelReason: "SLA_BREACH", items: [{ sku: "pizza", qty: 5, price: 2000 }], updatedAt: "2026-06-14T11:45:00.000Z" }),
  o({ tenantId: "tokyo", totalAmount: 300, status: "ACCEPTED", items: [{ sku: "sushi", qty: 3, price: 100 }], updatedAt: "2026-06-14T10:50:00.000Z" }),
];

describe("analytics", () => {
  it("aggregateGmv sums totalAmount excluding cancelled", () => {
    expect(aggregateGmv(orders)).toBe(1000 + 500 + 300);
  });
  it("gmvByTenant groups non-cancelled totals per tenant", () => {
    expect(gmvByTenant(orders)).toEqual([{ tenant: "berlin", gmv: 1500 }, { tenant: "tokyo", gmv: 300 }]);
  });
  it("statusBreakdown counts per tenant per status", () => {
    expect(statusBreakdown(orders)).toEqual([
      { tenant: "berlin", placed: 1, accepted: 1, cancelled: 1 },
      { tenant: "tokyo", placed: 0, accepted: 1, cancelled: 0 },
    ]);
  });
  it("topSkus sums qty over non-cancelled orders, desc, limited", () => {
    expect(topSkus(orders, 2)).toEqual([{ sku: "sushi", qty: 3 }, { sku: "pizza", qty: 2 }]);
  });
  it("gmvOverTime buckets by hour, excludes cancelled, ascending", () => {
    expect(gmvOverTime(orders)).toEqual([
      { bucket: "2026-06-14T10", gmv: 1300 },
      { bucket: "2026-06-14T11", gmv: 500 },
    ]);
  });
  it("orderCounts reports total, cancelled, rate", () => {
    expect(orderCounts(orders)).toEqual({ total: 4, cancelled: 1, cancelRate: 0.25 });
  });
  it("replaceTenantOrders swaps one tenant's slice, keeping others", () => {
    const next = replaceTenantOrders(orders, "berlin", [o({ tenantId: "berlin", orderId: "new" })]);
    expect(next.filter((x) => x.tenantId === "berlin").map((x) => x.orderId)).toEqual(["new"]);
    expect(next.filter((x) => x.tenantId === "tokyo")).toHaveLength(1);
  });
});
