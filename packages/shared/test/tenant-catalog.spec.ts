import { PrismaClient } from "@prisma/client";
import { TenantCatalogService } from "../src/tenant-catalog";

describe("TenantCatalogService (live DB)", () => {
  const prisma = new PrismaClient();
  const svc = new TenantCatalogService(prisma, 60000);
  const tmp = `zzz-${Date.now()}`;

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: tmp } });
    await prisma.$disconnect();
  });

  it("lists active tenants and resolves a known one (berlin seeded)", async () => {
    const list = await svc.list();
    expect(list.some((t) => t.slug === "berlin")).toBe(true);
    const berlin = await svc.get("berlin");
    expect(berlin?.lng).toBeCloseTo(13.405);
    expect(await svc.isActive("berlin")).toBe(true);
  });

  it("isActive is false for an unknown tenant", async () => {
    expect(await svc.isActive("nope-xyz")).toBe(false);
  });

  it("activeOnly hides a suspended tenant; refresh() picks up changes", async () => {
    await prisma.tenant.create({ data: { slug: tmp, displayName: "Tmp", lng: 0, lat: 0, status: "suspended" } });
    await svc.refresh();
    expect((await svc.list(true)).some((t) => t.slug === tmp)).toBe(false);
    expect((await svc.list(false)).some((t) => t.slug === tmp)).toBe(true);
    expect(await svc.isActive(tmp)).toBe(false);
  });

  it("fails closed on an empty cold cache when the DB is unreachable", async () => {
    const broken = { tenant: { findMany: async () => { throw new Error("db down"); } } } as unknown as PrismaClient;
    const cold = new TenantCatalogService(broken, 60000);
    await expect(cold.list()).rejects.toThrow();
  });
});
