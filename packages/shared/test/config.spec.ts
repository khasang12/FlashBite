import { loadConfig } from "../src/config";

describe("loadConfig tenant catalog", () => {
  it("defaults tenantCatalogTtlMs to 60000 and honors the env override", () => {
    expect(loadConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" }).tenantCatalogTtlMs).toBe(60000);
    expect(loadConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", TENANT_CATALOG_TTL_MS: "5000" }).tenantCatalogTtlMs).toBe(5000);
  });
});
