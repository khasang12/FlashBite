import { describe, it, expect } from "vitest";
import { toNearbyRows, formatKm } from "./nearby";
import type { NearbyDriver } from "../api/client";

const drivers: NearbyDriver[] = [
  { driverId: "drv-1", distanceKm: 0, lng: 13.4, lat: 52.5 },
  { driverId: "drv-7", distanceKm: 0.42, lng: 13.41, lat: 52.53 },
  { driverId: "drv-3", distanceKm: 1.2, lng: 13.39, lat: 52.51 },
];

describe("toNearbyRows", () => {
  it("excludes the caller's own driverId", () => {
    const rows = toNearbyRows(drivers, "drv-1");
    expect(rows.map((r) => r.driverId)).toEqual(["drv-7", "drv-3"]);
  });

  it("returns all rows when the caller is not present", () => {
    expect(toNearbyRows(drivers, "drv-99")).toHaveLength(3);
  });

  it("returns an empty array for empty input", () => {
    expect(toNearbyRows([], "drv-1")).toEqual([]);
  });
});

describe("formatKm", () => {
  it("formats kilometres to 2 decimals with a unit", () => {
    expect(formatKm(0.42)).toBe("0.42 km");
    expect(formatKm(1.2)).toBe("1.20 km");
    expect(formatKm(0)).toBe("0.00 km");
  });
});
