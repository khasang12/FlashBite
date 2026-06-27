import { runWithObsContext, getObsContext, newCorrelationId, obsLogFields } from "./obs-context";

describe("obs-context", () => {
  it("exposes the bound context inside the scope and nothing outside", () => {
    expect(getObsContext()).toBeUndefined();
    const out = runWithObsContext({ correlationId: "c1", tenantId: "berlin" }, () => {
      const ctx = getObsContext();
      return ctx?.correlationId + ":" + ctx?.tenantId;
    });
    expect(out).toBe("c1:berlin");
    expect(getObsContext()).toBeUndefined();
  });

  it("obsLogFields returns correlationId + present fields, omitting undefined", () => {
    expect(obsLogFields()).toEqual({});
    const fields = runWithObsContext({ correlationId: "c2", eventId: "e2" }, () => obsLogFields());
    expect(fields).toEqual({ correlationId: "c2", eventId: "e2" });
  });

  it("newCorrelationId returns a uuid-shaped string", () => {
    expect(newCorrelationId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
