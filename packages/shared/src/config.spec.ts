import { loadConfig } from "@flashbite/shared";

describe("loadConfig", () => {
  it("reads all settings from env with defaults", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5434/db",
      KAFKA_BROKERS: "localhost:9092",
      MONGO_URI: "mongodb://localhost:27017/flashbite_read",
      REDIS_CLUSTER_NODES: "127.0.0.1:7100,127.0.0.1:7101",
    });
    expect(cfg.databaseUrl).toBe("postgresql://u:p@localhost:5434/db");
    expect(cfg.kafkaBrokers).toEqual(["localhost:9092"]);
    expect(cfg.defaultTenantId).toBe("berlin");
    expect(cfg.mongoUri).toBe("mongodb://localhost:27017/flashbite_read");
    expect(cfg.redisClusterNodes).toEqual([
      { host: "127.0.0.1", port: 7100 },
      { host: "127.0.0.1", port: 7101 },
    ]);
  });

  it("defaults mongo + redis when unset", () => {
    const cfg = loadConfig({ DATABASE_URL: "x" });
    expect(cfg.mongoUri).toBe("mongodb://localhost:27017/flashbite_read");
    expect(cfg.redisClusterNodes).toHaveLength(6);
    expect(cfg.redisClusterNodes[0]).toEqual({ host: "127.0.0.1", port: 7100 });
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
