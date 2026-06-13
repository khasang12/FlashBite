import {
  runWithTenant,
  getTenantId,
  TenantContextError,
} from "@flashbite/tenant-context";

describe("tenant context", () => {
  it("exposes the tenant id inside the run scope", () => {
    const seen = runWithTenant("berlin", () => getTenantId());
    expect(seen).toBe("berlin");
  });

  it("throws when read outside any scope", () => {
    expect(() => getTenantId()).toThrow(TenantContextError);
  });

  it("isolates nested scopes", () => {
    runWithTenant("berlin", () => {
      const inner = runWithTenant("tokyo", () => getTenantId());
      expect(inner).toBe("tokyo");
      expect(getTenantId()).toBe("berlin");
    });
  });
});
