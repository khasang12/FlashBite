import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Roles, RolesGuard, ROLES_KEY } from "./roles.guard";
import { runWithAuth } from "./auth-context";

function ctxFor(handler: unknown): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe("RolesGuard", () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  it("decorator attaches role metadata", () => {
    class C {
      @Roles("merchant")
      handler(): void {}
    }
    const meta = reflector.get(ROLES_KEY, new C().handler);
    expect(meta).toEqual(["merchant"]);
  });

  it("allows a handler with no @Roles metadata", () => {
    const ok = runWithAuth({ tenantId: "berlin", role: "customer", sub: "c-1" }, () =>
      guard.canActivate(ctxFor(() => undefined)),
    );
    expect(ok).toBe(true);
  });

  it("allows a caller whose role matches", () => {
    class C {
      @Roles("merchant")
      handler(): void {}
    }
    const h = new C().handler;
    const ok = runWithAuth({ tenantId: "berlin", role: "merchant", sub: "m-1" }, () =>
      guard.canActivate(ctxFor(h)),
    );
    expect(ok).toBe(true);
  });

  it("forbids a caller whose role does not match (403)", () => {
    class C {
      @Roles("merchant")
      handler(): void {}
    }
    const h = new C().handler;
    expect(() =>
      runWithAuth({ tenantId: "berlin", role: "customer", sub: "c-1" }, () =>
        guard.canActivate(ctxFor(h)),
      ),
    ).toThrow(ForbiddenException);
  });

  it("allows a caller whose role is any one of several required (any-of)", () => {
    class C {
      @Roles("merchant", "operator")
      handler(): void {}
    }
    const h = new C().handler;
    expect(reflector.get(ROLES_KEY, h)).toEqual(["merchant", "operator"]);
    for (const role of ["merchant", "operator"]) {
      const ok = runWithAuth({ tenantId: "berlin", role, sub: "u-1" }, () =>
        guard.canActivate(ctxFor(h)),
      );
      expect(ok).toBe(true);
    }
  });

  it("forbids a caller whose role is in none of several required (403)", () => {
    class C {
      @Roles("merchant", "operator")
      handler(): void {}
    }
    const h = new C().handler;
    expect(() =>
      runWithAuth({ tenantId: "berlin", role: "customer", sub: "c-1" }, () =>
        guard.canActivate(ctxFor(h)),
      ),
    ).toThrow(ForbiddenException);
  });
});
