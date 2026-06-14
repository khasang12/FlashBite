import { describe, it, expect } from "vitest";
import { parseStreamData } from "./use-order-stream";

describe("parseStreamData", () => {
  it("parses a well-formed SSE data line into an OrderStreamEvent", () => {
    expect(parseStreamData(JSON.stringify({ orderId: "o-1", eventType: "OrderAccepted" })))
      .toEqual({ orderId: "o-1", eventType: "OrderAccepted" });
  });
  it("returns null for malformed JSON", () => {
    expect(parseStreamData("not json")).toBeNull();
  });
  it("returns null when orderId or eventType is missing", () => {
    expect(parseStreamData(JSON.stringify({ orderId: "o-1" }))).toBeNull();
    expect(parseStreamData(JSON.stringify({ eventType: "OrderPlaced" }))).toBeNull();
  });
});
