import { loadConfig } from "@flashbite/shared";

describe("loadConfig", () => {
  it("reads database and kafka settings from env with defaults", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      KAFKA_BROKERS: "localhost:9092",
    });
    expect(cfg.databaseUrl).toBe("postgresql://u:p@localhost:5432/db");
    expect(cfg.kafkaBrokers).toEqual(["localhost:9092"]);
    expect(cfg.defaultTenantId).toBe("berlin");
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
