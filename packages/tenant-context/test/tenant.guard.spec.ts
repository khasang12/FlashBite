import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { TenantGuard } from "../src/tenant.guard";
import { runWithAuth } from "../src/auth-context";

const guardWith = (catalog: Partial<{ isActive: (s: string) => Promise<boolean> }>) =>
  new TenantGuard(catalog as never);

describe("TenantGuard", () => {
  it("allows an active tenant", async () => {
    const g = guardWith({ isActive: async () => true });
    const ok = await runWithAuth({ tenantId: "berlin", role: "customer", sub: "c1" }, () => g.canActivate({} as never));
    expect(ok).toBe(true);
  });

  it("rejects an unknown/suspended tenant with 403", async () => {
    const g = guardWith({ isActive: async () => false });
    await expect(
      runWithAuth({ tenantId: "ghost", role: "customer", sub: "c1" }, () => g.canActivate({} as never)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("bypasses the check for the operator role (cross-tenant)", async () => {
    let called = false;
    const g = guardWith({ isActive: async () => { called = true; return false; } });
    const ok = await runWithAuth({ tenantId: "platform", role: "operator", sub: "op" }, () => g.canActivate({} as never));
    expect(ok).toBe(true);
    expect(called).toBe(false);
  });

  it("allows when there is no auth context (e.g. health)", async () => {
    const g = guardWith({ isActive: async () => false });
    expect(await g.canActivate({} as never)).toBe(true);
  });

  it("returns 503 when the catalog cannot load (cold cache)", async () => {
    const g = guardWith({ isActive: async () => { throw new Error("db down"); } });
    await expect(
      runWithAuth({ tenantId: "berlin", role: "customer", sub: "c1" }, () => g.canActivate({} as never)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
