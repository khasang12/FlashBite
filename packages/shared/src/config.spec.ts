import { loadConfig } from "@flashbite/shared";

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
