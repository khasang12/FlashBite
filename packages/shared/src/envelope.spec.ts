import { buildEnvelope } from "@flashbite/shared";
import { runWithObsContext } from "./obs-context";
import { EVENT_TYPES, type OrderPlacedPayload } from "@flashbite/contracts";

describe("buildEnvelope", () => {
  const payload: OrderPlacedPayload = {
    orderId: "o-1",
    customerId: "c-1",
    items: [{ sku: "pizza", qty: 1, price: 1200 }],
    totalAmount: 1200,
  };

  it("builds a well-formed envelope", () => {
    const env = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 1,
      payload,
    });

    expect(env.tenantId).toBe("berlin");
    expect(env.eventType).toBe("OrderPlaced");
    expect(env.version).toBe(1);
    expect(env.payload).toEqual(payload);
    expect(env.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new Date(env.occurredAt).toISOString()).not.toThrow();
  });

  it("generates a unique eventId per call", () => {
    const a = buildEnvelope({ tenantId: "berlin", eventType: "X", version: 1, payload });
    const b = buildEnvelope({ tenantId: "berlin", eventType: "X", version: 1, payload });
    expect(a.eventId).not.toBe(b.eventId);
  });
});

describe("buildEnvelope correlationId precedence", () => {
  const a = { tenantId: "berlin", eventType: "OrderPlaced", version: 1, payload: {} };

  it("prefers an explicit correlationId arg", () => {
    expect(buildEnvelope({ ...a, correlationId: "explicit" }).correlationId).toBe("explicit");
  });
  it("falls back to obsContext", () => {
    const env = runWithObsContext({ correlationId: "from-als" }, () => buildEnvelope(a));
    expect(env.correlationId).toBe("from-als");
  });
  it("mints one when nothing is in scope", () => {
    expect(buildEnvelope(a).correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
