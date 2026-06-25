import { parseCookie, buildSetCookie, clearSetCookie } from "../src/auth/cookie";

describe("cookie helpers", () => {
  it("parses a named cookie from the header", () => {
    expect(parseCookie("a=1; fb_rt=xyz; b=2", "fb_rt")).toBe("xyz");
    expect(parseCookie("a=1", "fb_rt")).toBeUndefined();
    expect(parseCookie(undefined, "fb_rt")).toBeUndefined();
  });

  it("builds an httpOnly SameSite=Strict Set-Cookie with Secure gated", () => {
    const secure = buildSetCookie("fb_rt", "v", { maxAgeSeconds: 100, secure: true, path: "/api/identity/auth" });
    expect(secure).toContain("fb_rt=v");
    expect(secure).toContain("Max-Age=100");
    expect(secure).toContain("Path=/api/identity/auth");
    expect(secure).toContain("HttpOnly");
    expect(secure).toContain("SameSite=Strict");
    expect(secure).toContain("Secure");
    const insecure = buildSetCookie("fb_rt", "v", { maxAgeSeconds: 100, secure: false, path: "/p" });
    expect(insecure).not.toContain("Secure");
  });

  it("clears the cookie with Max-Age=0", () => {
    const c = clearSetCookie("fb_rt", "/api/identity/auth");
    expect(c).toContain("fb_rt=;");
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("Path=/api/identity/auth");
  });
});
