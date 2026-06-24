import { loadConfig } from "../src/config";

describe("loadConfig auth/token + cookie defaults", () => {
  const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

  it("defaults the access TTL to 900 and refresh TTL to 2592000", () => {
    const cfg = loadConfig(base);
    expect(cfg.jwtAccessTtl).toBe(900);
    expect(cfg.jwtRefreshTtl).toBe(2592000);
  });

  it("defaults the RT cookie name/path and secure=false (dev)", () => {
    const cfg = loadConfig(base);
    expect(cfg.rtCookieName).toBe("fb_rt");
    expect(cfg.rtCookiePath).toBe("/api/identity/auth");
    expect(cfg.rtCookieSecure).toBe(false);
  });

  it("honors env overrides", () => {
    const cfg = loadConfig({ ...base, JWT_ACCESS_TTL: "60", JWT_REFRESH_TTL: "120", RT_COOKIE_SECURE: "true", RT_COOKIE_NAME: "x", RT_COOKIE_PATH: "/y" });
    expect(cfg.jwtAccessTtl).toBe(60);
    expect(cfg.jwtRefreshTtl).toBe(120);
    expect(cfg.rtCookieSecure).toBe(true);
    expect(cfg.rtCookieName).toBe("x");
    expect(cfg.rtCookiePath).toBe("/y");
  });
});
