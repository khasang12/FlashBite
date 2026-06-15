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
});
