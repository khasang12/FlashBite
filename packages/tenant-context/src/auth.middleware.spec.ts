import { UnauthorizedException } from "@nestjs/common";
import { AuthMiddleware } from "./auth.middleware";
import { getAuthContext } from "./auth-context";
import { createTestAuth, type TestAuth } from "./testing";

describe("AuthMiddleware", () => {
  let auth: TestAuth;
  let mw: AuthMiddleware;

  beforeAll(async () => {
    auth = await createTestAuth();
    mw = new AuthMiddleware(auth.verifier);
  });

  const reqWith = (header?: string) =>
    ({ headers: header ? { authorization: header } : {} }) as any;

  // next() captures whatever the middleware passes it (undefined on success,
  // an UnauthorizedException on auth failure — the Express error-propagation path).
  const capture = () => {
    const calls: unknown[] = [];
    const next = ((err?: unknown) => {
      calls.push(err);
    }) as any;
    return { calls, next };
  };

  it("calls next() with no error and within the auth scope for a valid Bearer token", async () => {
    const token = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
    let seen: unknown;
    const { calls, next } = capture();
    const wrapped = ((err?: unknown) => {
      calls.push(err);
      seen = getAuthContext();
    }) as any;
    await mw.use(reqWith(`Bearer ${token}`), {} as any, wrapped);
    expect(calls).toEqual([undefined]);
    expect(seen).toEqual({ tenantId: "berlin", role: "customer", sub: "c-1" });
  });

  it("passes UnauthorizedException to next when no Authorization header (401)", async () => {
    const { calls, next } = capture();
    await mw.use(reqWith(undefined), {} as any, next);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(UnauthorizedException);
  });

  it("passes UnauthorizedException to next for a non-Bearer header (401)", async () => {
    const { calls, next } = capture();
    await mw.use(reqWith("Basic abc"), {} as any, next);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(UnauthorizedException);
  });

  it("passes UnauthorizedException to next for an invalid token (401)", async () => {
    const { calls, next } = capture();
    await mw.use(reqWith("Bearer not.a.jwt"), {} as any, next);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(UnauthorizedException);
  });
});
