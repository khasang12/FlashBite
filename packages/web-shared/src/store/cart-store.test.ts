import { describe, it, expect, beforeEach } from "vitest";
import { useCartStore } from "./cart-store";

const item = { sku: "pizza", name: "Pizza", priceCents: 1200 };

describe("cart store", () => {
  beforeEach(() => useCartStore.getState().clear());

  it("adds items and accumulates qty for the same sku", () => {
    useCartStore.getState().add(item);
    useCartStore.getState().add(item);
    expect(useCartStore.getState().count()).toBe(2);
    expect(useCartStore.getState().totalCents()).toBe(2400);
  });

  it("setQty to 0 removes the line", () => {
    useCartStore.getState().add(item);
    useCartStore.getState().setQty("pizza", 0);
    expect(useCartStore.getState().items).toHaveLength(0);
  });

  it("totalCents sums lines", () => {
    useCartStore.getState().add(item);
    useCartStore.getState().add({ sku: "fries", name: "Fries", priceCents: 400 });
    expect(useCartStore.getState().totalCents()).toBe(1600);
  });
});
