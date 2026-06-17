import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "./auth-store";

function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

describe("auth store", () => {
  beforeEach(() => {
    useAuthStore.setState({ token: null, claims: null });
    vi.restoreAllMocks();
  });

  it("login stores the token and decoded claims", async () => {
    const token = makeJwt({ sub: "u-1", tenantId: "berlin", role: "customer" });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ accessToken: token, tokenType: "Bearer", expiresIn: 3600 }), { status: 201 })));
    await useAuthStore.getState().login("customer@berlin.test", "devpassword");
    expect(useAuthStore.getState().token).toBe(token);
    expect(useAuthStore.getState().claims).toEqual({ sub: "u-1", tenantId: "berlin", role: "customer" });
  });

  it("login throws on a 401 and leaves the store empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ message: "Invalid email or password" }), { status: 401 })));
    await expect(useAuthStore.getState().login("x@y.test", "bad")).rejects.toThrow();
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("logout clears token and claims", () => {
    useAuthStore.setState({ token: "t", claims: { sub: "s", tenantId: "berlin", role: "customer" } });
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().claims).toBeNull();
  });
});
