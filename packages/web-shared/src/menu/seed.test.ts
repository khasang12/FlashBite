import { describe, it, expect } from "vitest";
import { getMenu, getPopular, type MenuItem } from "./seed";

describe("menu seed", () => {
  it("returns a non-empty menu per tenant with cent prices", () => {
    const berlin = getMenu("berlin");
    expect(berlin.length).toBeGreaterThan(0);
    berlin.forEach((i: MenuItem) => {
      expect(typeof i.sku).toBe("string");
      expect(Number.isInteger(i.priceCents)).toBe(true);
    });
  });

  it("getPopular returns only popular items, ordered", () => {
    const popular = getPopular("berlin");
    expect(popular.length).toBeGreaterThan(0);
    expect(popular.every((i) => i.popular)).toBe(true);
  });

  it("isolates tenants (tokyo menu differs from berlin)", () => {
    expect(getMenu("tokyo")).not.toEqual(getMenu("berlin"));
  });
});
