import { loadConfig, requireAppDatabaseUrl } from "@flashbite/shared";

describe("loadConfig", () => {
  it("reads all settings from env with defaults", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5434/db",
      KAFKA_BROKERS: "localhost:9092",
      MONGO_URI: "mongodb://localhost:27017/flashbite_read",
      REDIS_CLUSTER_NODES: "127.0.0.1:7100,127.0.0.1:7101",
      TEMPORAL_ADDRESS: "localhost:7233",
      SAGA_SLA_SECONDS: "42",
    });
    expect(cfg.databaseUrl).toBe("postgresql://u:p@localhost:5434/db");
    expect(cfg.mongoUri).toBe("mongodb://localhost:27017/flashbite_read");
    expect(cfg.temporalAddress).toBe("localhost:7233");
    expect(cfg.sagaSlaSeconds).toBe(42);
  });

  it("defaults temporal + sla when unset", () => {
    const cfg = loadConfig({ DATABASE_URL: "x" });
    expect(cfg.temporalAddress).toBe("localhost:7233");
    expect(cfg.sagaSlaSeconds).toBe(300);
    expect(cfg.redisClusterNodes).toHaveLength(6);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});

describe("loadConfig appDatabaseUrl", () => {
  it("uses APP_DATABASE_URL when set, else falls back to DATABASE_URL", () => {
    const withApp = loadConfig({ DATABASE_URL: "postgres://owner", APP_DATABASE_URL: "postgres://app" });
    expect(withApp.appDatabaseUrl).toBe("postgres://app");
    const noApp = loadConfig({ DATABASE_URL: "postgres://owner" });
    expect(noApp.appDatabaseUrl).toBe("postgres://owner");
  });
});

describe("requireAppDatabaseUrl", () => {
  it("requireAppDatabaseUrl returns APP_DATABASE_URL when set", () => {
    expect(requireAppDatabaseUrl({ APP_DATABASE_URL: "postgres://app" })).toBe("postgres://app");
  });
  it("requireAppDatabaseUrl throws when APP_DATABASE_URL is missing", () => {
    expect(() => requireAppDatabaseUrl({})).toThrow(/APP_DATABASE_URL/);
  });
});

describe("loadConfig JWT settings", () => {
  const base = { DATABASE_URL: "postgres://x" };

  it("defaults issuer/audience/ttl", () => {
    const c = loadConfig({ ...base });
    expect(c.jwtIssuer).toBe("flashbite-identity");
    expect(c.jwtAudience).toBe("flashbite");
    expect(c.jwtAccessTtl).toBe(900);
  });

  it("reads overrides from env", () => {
    const c = loadConfig({ ...base, JWT_ISSUER: "iss", JWT_AUDIENCE: "aud", JWT_ACCESS_TTL: "900" });
    expect(c.jwtIssuer).toBe("iss");
    expect(c.jwtAudience).toBe("aud");
    expect(c.jwtAccessTtl).toBe(900);
  });

  it("defaults jwtJwksUrl to the local identity JWKS endpoint", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://x" });
    expect(cfg.jwtJwksUrl).toBe("http://localhost:3003/.well-known/jwks.json");
  });
});
