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

  it("runs next within the auth scope for a valid Bearer token", async () => {
    const token = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
    let seen: unknown;
    await mw.use(reqWith(`Bearer ${token}`), {} as any, () => {
      seen = getAuthContext();
    });
    expect(seen).toEqual({ tenantId: "berlin", role: "customer", sub: "c-1" });
  });

  it("rejects a request with no Authorization header (401)", async () => {
    await expect(mw.use(reqWith(undefined), {} as any, () => undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("rejects a non-Bearer Authorization header (401)", async () => {
    await expect(
      mw.use(reqWith("Basic abc"), {} as any, () => undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects an invalid token (401)", async () => {
    await expect(
      mw.use(reqWith("Bearer not.a.jwt"), {} as any, () => undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
