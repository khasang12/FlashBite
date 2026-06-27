import { buildHeaders, parseHeaders } from "./headers";

describe("correlationId header", () => {
  const base = { eventType: "OrderPlaced", tenantId: "berlin", eventId: "e1", version: 1, occurredAt: "2026-01-01T00:00:00.000Z" };

  it("round-trips correlationId through build/parse", () => {
    const headers = buildHeaders({ ...base, correlationId: "corr-123" });
    expect(headers.correlationId).toBe("corr-123");
    expect(parseHeaders(headers as any).correlationId).toBe("corr-123");
  });

  it("mints a correlationId when the header is absent (lenient), without throwing", () => {
    const headers = buildHeaders(base as any); // correlationId omitted upstream
    const meta = parseHeaders({ eventType: Buffer.from("OrderPlaced"), tenantId: Buffer.from("berlin"), eventId: Buffer.from("e1") } as any);
    expect(meta.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    void headers;
  });
});

describe("messaging headers", () => {
  const meta = {
    tenantId: "berlin",
    eventId: "evt-1",
    eventType: "OrderPlaced",
    version: 3,
    occurredAt: "2026-06-19T00:00:00.000Z",
    correlationId: "corr-abc",
  };

  it("round-trips metadata through string headers", () => {
    const headers = buildHeaders(meta);
    expect(headers).toEqual({
      eventType: "OrderPlaced",
      tenantId: "berlin",
      eventId: "evt-1",
      version: "3",
      occurredAt: "2026-06-19T00:00:00.000Z",
      correlationId: "corr-abc",
    });
    // kafkajs delivers header values as Buffers
    const asBuffers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)]));
    expect(parseHeaders(asBuffers)).toEqual(meta);
  });

  it("coerces version to a number and defaults optional occurredAt to empty", () => {
    const parsed = parseHeaders({
      eventType: Buffer.from("OrderPlaced"),
      tenantId: Buffer.from("berlin"),
      eventId: Buffer.from("evt-1"),
      version: Buffer.from("7"),
      // occurredAt omitted — optional
    });
    expect(parsed.version).toBe(7);
    expect(parsed.occurredAt).toBe("");
  });

  it("fails closed when required metadata is missing", () => {
    // no headers at all
    expect(() => parseHeaders(undefined)).toThrow(/missing required envelope header/);
    // missing tenantId (RLS-critical) and eventId
    expect(() => parseHeaders({ eventType: Buffer.from("OrderPlaced") })).toThrow(/tenantId/);
    // present-but-empty is treated as missing
    expect(() =>
      parseHeaders({ eventType: Buffer.from(""), tenantId: Buffer.from("berlin"), eventId: Buffer.from("e") }),
    ).toThrow(/eventType/);
  });
});
