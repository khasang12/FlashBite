import { describe, it, expect } from "vitest";
import { CITY_CENTERS } from "./city-centers";
import { TENANTS } from "../store/tenant-store";

describe("CITY_CENTERS", () => {
  it("has a center for every tenant", () => {
    for (const t of TENANTS) {
      expect(CITY_CENTERS[t]).toBeDefined();
      expect(typeof CITY_CENTERS[t].lng).toBe("number");
      expect(typeof CITY_CENTERS[t].lat).toBe("number");
    }
  });

  it("seeds Berlin and Tokyo at their known centers", () => {
    expect(CITY_CENTERS.berlin).toEqual({ lng: 13.405, lat: 52.52 });
    expect(CITY_CENTERS.tokyo).toEqual({ lng: 139.7, lat: 35.68 });
  });
});
