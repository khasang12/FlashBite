import { buildHeaders, parseHeaders } from "./headers";

describe("messaging headers", () => {
  const meta = {
    tenantId: "berlin",
    eventId: "evt-1",
    eventType: "OrderPlaced",
    version: 3,
    occurredAt: "2026-06-19T00:00:00.000Z",
  };

  it("round-trips metadata through string headers", () => {
    const headers = buildHeaders(meta);
    expect(headers).toEqual({
      eventType: "OrderPlaced",
      tenantId: "berlin",
      eventId: "evt-1",
      version: "3",
      occurredAt: "2026-06-19T00:00:00.000Z",
    });
    // kafkajs delivers header values as Buffers
    const asBuffers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)]));
    expect(parseHeaders(asBuffers)).toEqual(meta);
  });

  it("coerces version to a number and defaults missing headers to empty", () => {
    expect(parseHeaders(undefined)).toEqual({ eventType: "", tenantId: "", eventId: "", version: 0, occurredAt: "" });
    expect(parseHeaders({ version: Buffer.from("7") }).version).toBe(7);
  });
});
