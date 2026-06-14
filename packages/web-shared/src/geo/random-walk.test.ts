import { describe, it, expect, vi } from "vitest";
import { randomWalk } from "./random-walk";

describe("randomWalk", () => {
  it("returns a position within ±step of the input on each axis", () => {
    const from = { lng: 13.405, lat: 52.52 };
    const step = 0.0008;
    for (let i = 0; i < 200; i++) {
      const next = randomWalk(from, step);
      expect(Math.abs(next.lng - from.lng)).toBeLessThanOrEqual(step);
      expect(Math.abs(next.lat - from.lat)).toBeLessThanOrEqual(step);
    }
  });

  it("clamps to valid lng/lat bounds at the extremes", () => {
    // Force the max-positive delta: Math.random() = 1 -> delta = +stepDeg.
    const hi = vi.spyOn(Math, "random").mockReturnValue(1);
    expect(randomWalk({ lng: 180, lat: 90 }, 1)).toEqual({ lng: 180, lat: 90 });
    hi.mockRestore();
    // Force the max-negative delta: Math.random() = 0 -> delta = -stepDeg.
    const lo = vi.spyOn(Math, "random").mockReturnValue(0);
    expect(randomWalk({ lng: -180, lat: -90 }, 1)).toEqual({ lng: -180, lat: -90 });
    lo.mockRestore();
  });

  it("does not mutate the input", () => {
    const from = { lng: 1, lat: 2 };
    randomWalk(from, 0.5);
    expect(from).toEqual({ lng: 1, lat: 2 });
  });
});
