import "reflect-metadata";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { loadConfig } from "@flashbite/shared";

// flashbite_app (restricted) vs superuser. set_config(..., true) is transaction-local,
// so each isolation assertion runs inside its own interactive transaction.
describe("RLS tenant isolation (event_store/outbox)", () => {
  // Derive the restricted-role URL from DATABASE_URL (swap credentials) so this test
  // always targets flashbite_app — independent of whether APP_DATABASE_URL is set.
  // Password matches the dev role created by the 20260616000000_rls migration.
  const restrictedUrl = (() => {
    const u = new URL(loadConfig().databaseUrl);
    u.username = "flashbite_app";
    u.password = "flashbite_app_local_dev";
    return u.toString();
  })();
  const app = new PrismaClient({ datasourceUrl: restrictedUrl });
  const owner = new PrismaClient(); // DATABASE_URL — superuser, bypasses RLS

  beforeAll(async () => {
    await app.$connect();
    await owner.$connect();
  });
  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  const seedRow = (tenantId: string) => {
    const id = randomUUID();
    return {
      id,
      tenantId,
      aggregateType: "Order",
      aggregateId: id,
      version: 1,
      eventType: "OrderPlaced",
      payload: { orderId: id },
    };
  };

  it("blocks inserting a row whose tenant_id != app.tenant_id (WITH CHECK)", async () => {
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', 'berlin', true)`;
        await tx.eventStore.create({ data: seedRow("tokyo") as never });
      }),
    ).rejects.toThrow();
  });

  it("allows inserting a row whose tenant_id == app.tenant_id", async () => {
    const row = seedRow("berlin");
    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', 'berlin', true)`;
      await tx.eventStore.create({ data: row as never });
    });
    const found = await owner.eventStore.findUnique({ where: { id: row.id } });
    expect(found?.tenantId).toBe("berlin");
  });

  it("hides other tenants' rows from a scoped SELECT (USING)", async () => {
    const tokyoRow = seedRow("tokyo");
    await owner.eventStore.create({ data: tokyoRow as never });

    const seenByBerlin = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', 'berlin', true)`;
      return tx.eventStore.findMany({ where: { aggregateId: tokyoRow.aggregateId } });
    });
    expect(seenByBerlin).toHaveLength(0);

    const seenByTokyo = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', 'tokyo', true)`;
      return tx.eventStore.findMany({ where: { aggregateId: tokyoRow.aggregateId } });
    });
    expect(seenByTokyo).toHaveLength(1);
  });

  it("fail-closed: with no app.tenant_id set, the restricted role sees nothing", async () => {
    const rows = await app.eventStore.findMany({ take: 5 });
    expect(rows).toHaveLength(0);
  });

  it("the superuser connection sees rows across tenants", async () => {
    const all = await owner.eventStore.findMany({ take: 5 });
    expect(all.length).toBeGreaterThan(0);
  });
});
