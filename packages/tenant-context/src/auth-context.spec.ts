import {
  runWithAuth,
  getAuthContext,
  getTenantId,
  getRole,
  AuthContextError,
  type AuthContext,
} from "./auth-context";

const ctx: AuthContext = { tenantId: "berlin", role: "customer", sub: "c-1" };

describe("auth context", () => {
  it("exposes tenantId, role and the full context inside the run scope", () => {
    const seen = runWithAuth(ctx, () => ({
      tenantId: getTenantId(),
      role: getRole(),
      all: getAuthContext(),
    }));
    expect(seen.tenantId).toBe("berlin");
    expect(seen.role).toBe("customer");
    expect(seen.all).toEqual(ctx);
  });

  it("throws when read outside any scope", () => {
    expect(() => getTenantId()).toThrow(AuthContextError);
    expect(() => getRole()).toThrow(AuthContextError);
    expect(() => getAuthContext()).toThrow(AuthContextError);
  });

  it("isolates nested scopes", () => {
    runWithAuth(ctx, () => {
      const inner = runWithAuth({ tenantId: "tokyo", role: "merchant", sub: "m-1" }, () =>
        getTenantId(),
      );
      expect(inner).toBe("tokyo");
      expect(getTenantId()).toBe("berlin");
    });
  });
});
