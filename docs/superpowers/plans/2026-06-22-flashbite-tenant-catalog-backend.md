# Tenant catalog (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `TENANTS`/`CITY_CENTERS` constants with a DB-backed, cached tenant catalog, and add per-request active-tenant validation (the TCS check).

**Architecture:** A `tenants` table feeds a cached `TenantCatalogService` (`@flashbite/shared`). A `TenantGuard` (in `@flashbite/tenant-context`) validates each request's JWT `tenantId` against the active catalog in read-api + write-api. `AdminService` fan-out, the saga dispatch center lookup, and identity seeding read the catalog; `GET /tenants` exposes it. Frontends are untouched (Slice B).

**Tech Stack:** NestJS 10.4.4 + Prisma 5.18 (Postgres), Jest/ts-jest (+ supertest), live Postgres for catalog/guard/e2e tests.

**Branch:** `phase-tenant-catalog-backend` (already created off `main`).

## Global Constraints

- `tenants` table is **not** under RLS; the migration MUST `GRANT SELECT ON "tenants" TO flashbite_app` (the restricted role used by read-api/write-api/saga-worker).
- `slug` (PK) equals the JWT `tenantId`. Seed `berlin` ("Berlin", lng 13.405, lat 52.52) and `tokyo` ("Tokyo", lng 139.7, lat 35.68), both `status="active"`.
- Catalog cache: in-memory per process, TTL default 60000ms (`TENANT_CATALOG_TTL_MS`); resilient (serve stale on DB error when cache non-empty) but fail-closed (throw when cache empty).
- `TenantGuard`: no auth context → allow; `role === "operator"` → allow (cross-tenant; the operator user's `tenantId` is `"platform"`, deliberately NOT a catalog tenant); unknown/suspended → `403`; catalog load failure with empty cache → `503`.
- `contracts`: `Tenant` becomes `type Tenant = string`; `TENANTS` and `CITY_CENTERS` are removed; add `interface TenantView { slug: string; displayName: string; lng: number; lat: number; status: string }`. (Removal happens in the final task, after all consumers are migrated, to keep the tree green.)
- Frontends (web-shared `TENANTS`/`CITY_CENTERS`, the 4 apps) are OUT OF SCOPE — do not touch them.
- `TenantCatalogService` constructor takes a `PrismaClient` (so apps pass `PrismaService` — which extends `PrismaClient` — and the worker/seeds pass a bare `PrismaClient`).

---

## Task 1: tenants table + migration + seed + config + TenantView

**Files:**
- Modify: `packages/shared/prisma/schema.prisma`
- Create: `packages/shared/prisma/migrations/20260622090000_tenants/migration.sql`
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/contracts/src/index.ts` (ADD `TenantView` only — do NOT remove `TENANTS`/`CITY_CENTERS` yet)
- Create: `apps/identity/src/seed-tenants.ts`
- Modify: `package.json` (root — add `seed:tenants`; update `db:setup`)
- Test: `packages/shared/test/config.spec.ts` (extend if present, else create)

**Interfaces:**
- Produces: Prisma model `Tenant` → `prisma.tenant`; `AppConfig.tenantCatalogTtlMs: number`; `contracts.TenantView`; a `seed:tenants` script.

- [ ] **Step 1: Write/extend the failing config test** — in `packages/shared/test/config.spec.ts` add (create the file with the standard import if it doesn't exist):
```ts
import { loadConfig } from "../src/config";
describe("loadConfig tenant catalog", () => {
  it("defaults tenantCatalogTtlMs to 60000 and honors the env override", () => {
    expect(loadConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" }).tenantCatalogTtlMs).toBe(60000);
    expect(loadConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", TENANT_CATALOG_TTL_MS: "5000" }).tenantCatalogTtlMs).toBe(5000);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `pnpm jest packages/shared/test/config.spec.ts` (fails: `tenantCatalogTtlMs` undefined).

- [ ] **Step 3: Add the Prisma model** — append to `packages/shared/prisma/schema.prisma`:
```prisma
model Tenant {
  slug        String   @id
  displayName String   @map("display_name")
  lng         Float
  lat         Float
  status      String   @default("active")
  createdAt   DateTime @default(now()) @map("created_at")
  @@map("tenants")
}
```

- [ ] **Step 4: Write the migration** — create `packages/shared/prisma/migrations/20260622090000_tenants/migration.sql`:
```sql
CREATE TABLE "tenants" (
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tenants_pkey" PRIMARY KEY ("slug")
);

-- The restricted app role (read-api/write-api/saga-worker) must read the catalog.
-- Not under RLS: this is the global cross-tenant catalog.
GRANT SELECT ON "tenants" TO flashbite_app;
```

- [ ] **Step 5: Add config field** — in `packages/shared/src/config.ts`, add to the `AppConfig` interface: `tenantCatalogTtlMs: number;`, and to the `loadConfig` return object: `tenantCatalogTtlMs: Number(env.TENANT_CATALOG_TTL_MS ?? 60000),`.

- [ ] **Step 6: Add `TenantView` to contracts** — in `packages/contracts/src/index.ts`, immediately after the `GeoPoint` interface, add (leave `TENANTS`/`CITY_CENTERS`/`Tenant` untouched for now):
```ts
export interface TenantView {
  slug: string;
  displayName: string;
  lng: number;
  lat: number;
  status: string;
}
```

- [ ] **Step 7: Write the seed script** — create `apps/identity/src/seed-tenants.ts`:
```ts
import { PrismaClient } from "@flashbite/shared";

const SEED_TENANTS = [
  { slug: "berlin", displayName: "Berlin", lng: 13.405, lat: 52.52 },
  { slug: "tokyo", displayName: "Tokyo", lng: 139.7, lat: 35.68 },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    for (const t of SEED_TENANTS) {
      await prisma.tenant.upsert({
        where: { slug: t.slug },
        update: { displayName: t.displayName, lng: t.lng, lat: t.lat, status: "active" },
        create: { ...t, status: "active" },
      });
      // eslint-disable-next-line no-console
      console.log(`seeded tenant ${t.slug} (${t.displayName})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 8: Wire the scripts** — in the root `package.json` `scripts`, add `"seed:tenants": "node -r @swc-node/register apps/identity/src/seed-tenants.ts"` (match the existing `seed:users` invocation style — copy its node/register flags exactly), and change `db:setup` to run tenants before users: `"db:setup": "pnpm db:deploy && pnpm db:generate && pnpm seed:tenants && pnpm seed:users"`.

- [ ] **Step 9: Apply migration + regenerate + seed** — run `pnpm db:deploy`, then `pnpm db:generate`, then `pnpm seed:tenants` (expect: migration `20260622090000_tenants` applied; `prisma.tenant` available; two tenants seeded). If `db:deploy` fails for an environment reason you cannot resolve, report BLOCKED with the error.

- [ ] **Step 10: Run config test** — `pnpm jest packages/shared/test/config.spec.ts` (expect PASS).

- [ ] **Step 11: Commit**
```bash
git add packages/shared/prisma/schema.prisma packages/shared/prisma/migrations/20260622090000_tenants packages/shared/src/config.ts packages/contracts/src/index.ts apps/identity/src/seed-tenants.ts package.json packages/shared/test/config.spec.ts
git commit -m "feat(tenants): tenants table + migration (grant) + seed:tenants + TenantView + catalog TTL config"
```

---

## Task 2: TenantCatalogService

**Files:**
- Create: `packages/shared/src/tenant-catalog.ts`
- Modify: `packages/shared/src/index.ts` (export it)
- Test: `packages/shared/test/tenant-catalog.spec.ts`

**Interfaces:**
- Consumes: `prisma.tenant` (Task 1), `contracts.TenantView`, `loadConfig`.
- Produces: `TenantCatalogService` with `constructor(prisma: PrismaClient, @Optional() ttlMs?: number)`, `list(activeOnly=true): Promise<TenantView[]>`, `get(slug): Promise<TenantView | null>`, `isActive(slug): Promise<boolean>`, `refresh(): Promise<void>`.

- [ ] **Step 1: Write the failing test** — create `packages/shared/test/tenant-catalog.spec.ts`:
```ts
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
```

- [ ] **Step 2: Run it, confirm it fails** — `pnpm jest packages/shared/test/tenant-catalog.spec.ts` (fails: module not found).

- [ ] **Step 3: Implement** — create `packages/shared/src/tenant-catalog.ts`:
```ts
import { Injectable, Optional } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { TenantView } from "@flashbite/contracts";
import { loadConfig } from "./config";

/**
 * Cached, DB-backed tenant catalog (the TCS-lite). Read-heavy / write-rare, so each process keeps
 * an in-memory copy with a short TTL plus a manual refresh(). Resilient: a DB blip serves the last
 * good cache; a cold cache with an unreachable DB throws (fail-closed) so callers can deny.
 */
@Injectable()
export class TenantCatalogService {
  private cache: TenantView[] | null = null;
  private loadedAt = 0;
  private readonly ttlMs: number;

  constructor(private readonly prisma: PrismaClient, @Optional() ttlMs?: number) {
    this.ttlMs = ttlMs ?? loadConfig().tenantCatalogTtlMs;
  }

  private async ensureFresh(): Promise<TenantView[]> {
    if (this.cache !== null && Date.now() - this.loadedAt < this.ttlMs) return this.cache;
    try {
      const rows = await this.prisma.tenant.findMany();
      this.cache = rows.map((r) => ({ slug: r.slug, displayName: r.displayName, lng: r.lng, lat: r.lat, status: r.status }));
      this.loadedAt = Date.now();
      return this.cache;
    } catch (err) {
      if (this.cache !== null) return this.cache; // resilient: serve stale
      throw err; // fail-closed cold start
    }
  }

  async list(activeOnly = true): Promise<TenantView[]> {
    const all = await this.ensureFresh();
    return activeOnly ? all.filter((t) => t.status === "active") : all;
  }

  async get(slug: string): Promise<TenantView | null> {
    return (await this.ensureFresh()).find((t) => t.slug === slug) ?? null;
  }

  async isActive(slug: string): Promise<boolean> {
    const t = await this.get(slug);
    return t !== null && t.status === "active";
  }

  async refresh(): Promise<void> {
    this.cache = null;
    await this.ensureFresh();
  }
}
```

- [ ] **Step 4: Export it** — add to `packages/shared/src/index.ts`: `export * from "./tenant-catalog";`.

- [ ] **Step 5: Run the test, confirm pass** — `pnpm jest packages/shared/test/tenant-catalog.spec.ts` (expect PASS; needs infra + seeded tenants from Task 1).

- [ ] **Step 6: Commit**
```bash
git add packages/shared/src/tenant-catalog.ts packages/shared/src/index.ts packages/shared/test/tenant-catalog.spec.ts
git commit -m "feat(shared): cached TenantCatalogService (list/get/isActive/refresh)"
```

---

## Task 3: TenantGuard

**Files:**
- Create: `packages/tenant-context/src/tenant.guard.ts`
- Modify: `packages/tenant-context/src/index.ts` (export it)
- Test: `packages/tenant-context/test/tenant.guard.spec.ts` (create the `test/` dir if absent)

**Interfaces:**
- Consumes: `TenantCatalogService` (Task 2), `getAuthContext`/`AuthContextError` from `./auth-context`.
- Produces: `TenantGuard` (a Nest `CanActivate`) injecting `TenantCatalogService`.

- [ ] **Step 1: Write the failing test** — create `packages/tenant-context/test/tenant.guard.spec.ts`:
```ts
import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { TenantGuard } from "../src/tenant.guard";
import { runWithAuth } from "../src/auth-context";

const guardWith = (catalog: Partial<{ isActive: (s: string) => Promise<boolean> }>) =>
  new TenantGuard(catalog as never);

describe("TenantGuard", () => {
  it("allows an active tenant", async () => {
    const g = guardWith({ isActive: async () => true });
    const ok = await runWithAuth({ tenantId: "berlin", role: "customer", sub: "c1" }, () => g.canActivate({} as never));
    expect(ok).toBe(true);
  });

  it("rejects an unknown/suspended tenant with 403", async () => {
    const g = guardWith({ isActive: async () => false });
    await expect(
      runWithAuth({ tenantId: "ghost", role: "customer", sub: "c1" }, () => g.canActivate({} as never)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("bypasses the check for the operator role (cross-tenant)", async () => {
    let called = false;
    const g = guardWith({ isActive: async () => { called = true; return false; } });
    const ok = await runWithAuth({ tenantId: "platform", role: "operator", sub: "op" }, () => g.canActivate({} as never));
    expect(ok).toBe(true);
    expect(called).toBe(false);
  });

  it("allows when there is no auth context (e.g. health)", async () => {
    const g = guardWith({ isActive: async () => false });
    expect(await g.canActivate({} as never)).toBe(true);
  });

  it("returns 503 when the catalog cannot load (cold cache)", async () => {
    const g = guardWith({ isActive: async () => { throw new Error("db down"); } });
    await expect(
      runWithAuth({ tenantId: "berlin", role: "customer", sub: "c1" }, () => g.canActivate({} as never)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `pnpm jest packages/tenant-context/test/tenant.guard.spec.ts` (fails: module not found).

- [ ] **Step 3: Implement** — create `packages/tenant-context/src/tenant.guard.ts`:
```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { TenantCatalogService } from "@flashbite/shared";
import { getAuthContext, AuthContextError } from "./auth-context";

// Mirrors ROLES.OPERATOR from @flashbite/contracts; hardcoded to avoid adding a contracts dep
// to this package. The operator principal is cross-tenant (tenantId "platform"), so it bypasses
// the single-tenant active check.
const OPERATOR_ROLE = "operator";

/** Per-request TCS check: the JWT tenantId must be a real, active catalog tenant. */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly catalog: TenantCatalogService) {}

  async canActivate(_ctx: ExecutionContext): Promise<boolean> {
    let auth;
    try {
      auth = getAuthContext();
    } catch (e) {
      if (e instanceof AuthContextError) return true; // no context (health/pre-auth) — not our job
      throw e;
    }
    if (auth.role === OPERATOR_ROLE) return true;
    let active: boolean;
    try {
      active = await this.catalog.isActive(auth.tenantId);
    } catch {
      throw new ServiceUnavailableException("tenant catalog unavailable");
    }
    if (active) return true;
    throw new ForbiddenException("Unknown or inactive tenant");
  }
}
```

- [ ] **Step 4: Export it** — add to `packages/tenant-context/src/index.ts`: `export * from "./tenant.guard";`.

- [ ] **Step 5: Run the test, confirm pass** — `pnpm jest packages/tenant-context/test/tenant.guard.spec.ts` (expect PASS).

- [ ] **Step 6: Commit**
```bash
git add packages/tenant-context/src/tenant.guard.ts packages/tenant-context/src/index.ts packages/tenant-context/test/tenant.guard.spec.ts
git commit -m "feat(tenant-context): TenantGuard — per-request active-tenant validation"
```

---

## Task 4: read-api adopts the catalog (guard + GET /tenants + AdminService fan-out)

**Files:**
- Modify: `apps/read-api/src/app.module.ts` (register `TenantGuard` as `APP_GUARD`; provide `PrismaService` + `TenantCatalogService`)
- Create: `apps/read-api/src/tenants/tenants.controller.ts`, `apps/read-api/src/tenants/tenants.module.ts`
- Modify: `apps/read-api/src/admin/admin.service.ts`, `apps/read-api/src/admin/admin.controller.ts`, `apps/read-api/src/admin/admin.module.ts`
- Test: `apps/read-api/test/tenants.e2e-spec.ts`

**Interfaces:**
- Consumes: `TenantCatalogService` (Task 2), `TenantGuard` (Task 3), `PrismaService` from `@flashbite/shared`.
- Produces: `GET /tenants` → `TenantView[]` (active); `AdminService.listAllDrivers` driven by the catalog.

- [ ] **Step 1: Write the failing e2e** — create `apps/read-api/test/tenants.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestAuth } from "@flashbite/tenant-context/testing";
import { AppModule } from "../src/app.module";

describe("read-api /tenants + TenantGuard (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it("GET /tenants returns active tenants for a valid tenant user", async () => {
    const token = await createTestAuth({ tenantId: "berlin", role: "customer", sub: "c1" });
    const res = await request(app.getHttpServer()).get("/tenants").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((t: { slug: string }) => t.slug === "berlin")).toBe(true);
  });

  it("rejects a request whose tenantId is not an active catalog tenant (403)", async () => {
    const token = await createTestAuth({ tenantId: "ghost-tenant", role: "customer", sub: "c1" });
    const res = await request(app.getHttpServer()).get("/tenants").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
```
> NOTE to implementer: confirm the exact test-auth helper. The codebase exposes a test-token helper via `@flashbite/tenant-context/testing` (used by other e2e specs — grep `createTestAuth`/`/testing`). Use whatever that module actually exports to mint a Bearer the `AuthMiddleware` accepts; mirror an existing read-api e2e's setup.

- [ ] **Step 2: Run it, confirm it fails** — `pnpm jest apps/read-api/test/tenants.e2e-spec.ts` (fails: no `/tenants` route / guard not wired).

- [ ] **Step 3: Create the tenants module + controller** — `apps/read-api/src/tenants/tenants.controller.ts`:
```ts
import { Controller, Get } from "@nestjs/common";
import { TenantCatalogService } from "@flashbite/shared";
import type { TenantView } from "@flashbite/contracts";

@Controller("tenants")
export class TenantsController {
  constructor(private readonly catalog: TenantCatalogService) {}

  @Get()
  list(): Promise<TenantView[]> {
    return this.catalog.list();
  }
}
```
`apps/read-api/src/tenants/tenants.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { PrismaService, TenantCatalogService } from "@flashbite/shared";
import { TenantsController } from "./tenants.controller";

@Module({
  controllers: [TenantsController],
  providers: [
    PrismaService,
    { provide: TenantCatalogService, useFactory: (p: PrismaService) => new TenantCatalogService(p), inject: [PrismaService] },
  ],
})
export class TenantsModule {}
```

- [ ] **Step 4: Register the guard globally + provide the catalog at the root** — rewrite `apps/read-api/src/app.module.ts`:
```ts
import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthMiddleware, TokenVerifier, TenantGuard } from "@flashbite/tenant-context";
import { PrismaService, TenantCatalogService } from "@flashbite/shared";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";
import { SseModule } from "./sse/sse.module";
import { DriversModule } from "./drivers/drivers.module";
import { AdminModule } from "./admin/admin.module";
import { DispatchModule } from "./dispatch/dispatch.module";
import { TenantsModule } from "./tenants/tenants.module";

@Module({
  imports: [OrdersModule, SseModule, DriversModule, AdminModule, DispatchModule, TenantsModule],
  controllers: [HealthController],
  providers: [
    TokenVerifier,
    PrismaService,
    { provide: TenantCatalogService, useFactory: (p: PrismaService) => new TenantCatalogService(p), inject: [PrismaService] },
    { provide: APP_GUARD, useFactory: (catalog: TenantCatalogService) => new TenantGuard(catalog), inject: [TenantCatalogService] },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).exclude("health").forRoutes("*");
  }
}
```

- [ ] **Step 5: Rewrite AdminService to use the catalog** — in `apps/read-api/src/admin/admin.service.ts`: drop `TENANTS`/`CITY_CENTERS` from the contracts import; inject the catalog; iterate it. Replace the constructor and `listAllDrivers`:
```ts
import { Injectable } from "@nestjs/common";
import { MongoService, RedisService, TenantCatalogService } from "@flashbite/shared";
import { READ_COLLECTIONS, type OrderView, type NearbyDriver, driverGeoKey } from "@flashbite/contracts";

const ADMIN_NEARBY_RADIUS_KM = 50;

export interface TenantNearbyDriver extends NearbyDriver {
  tenantId: string;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly mongo: MongoService,
    private readonly redis: RedisService,
    private readonly catalog: TenantCatalogService,
  ) {}

  // listAllOrders() is UNCHANGED — keep it exactly as-is.

  async listAllDrivers(): Promise<TenantNearbyDriver[]> {
    const tenants = await this.catalog.list();
    const perTenant = await Promise.all(
      tenants.map(async ({ slug: tenantId, lng, lat }) => {
        const raw = (await this.redis.cluster.geosearch(
          driverGeoKey(tenantId), "FROMLONLAT", String(lng), String(lat),
          "BYRADIUS", String(ADMIN_NEARBY_RADIUS_KM), "km", "ASC", "WITHDIST", "WITHCOORD",
        )) as Array<[string, string, [string, string]]>;
        return raw.map(([driverId, dist, [dlng, dlat]]) => ({
          tenantId, driverId, distanceKm: Number(dist), lng: Number(dlng), lat: Number(dlat),
        }));
      }),
    );
    return perTenant.flat();
  }
}
```
Keep `listAllOrders()` exactly as it is now (only the imports, constructor, and `listAllDrivers` change).

- [ ] **Step 6: Rewrite the admin SSE fan-out** — in `apps/read-api/src/admin/admin.controller.ts`: drop `TENANTS` from the contracts import, inject `AdminService` already present (it has the catalog) — but the controller needs the slug list too. Inject `TenantCatalogService` and make `ordersStream` build streams from it:
```ts
import { Controller, Get, Sse, UseGuards } from "@nestjs/common";
import { Observable, from, merge } from "rxjs";
import { map, mergeMap } from "rxjs/operators";
import { Roles, RolesGuard } from "@flashbite/tenant-context";
import { ROLES, type OrderView } from "@flashbite/contracts";
import { TenantCatalogService } from "@flashbite/shared";
import { AdminService, type TenantNearbyDriver } from "./admin.service";
import { OrderStreamService } from "../sse/order-stream.service";

interface MessageEvent { data: unknown; }

@Controller("admin")
@UseGuards(RolesGuard)
@Roles(ROLES.OPERATOR)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly stream: OrderStreamService,
    private readonly catalog: TenantCatalogService,
  ) {}

  @Get("orders")
  listOrders(): Promise<OrderView[]> { return this.admin.listAllOrders(); }

  @Get("drivers")
  listDrivers(): Promise<TenantNearbyDriver[]> { return this.admin.listAllDrivers(); }

  @Sse("orders/stream")
  ordersStream(): Observable<MessageEvent> {
    return from(this.catalog.list()).pipe(
      mergeMap((tenants) =>
        merge(...tenants.map(({ slug: tenantId }) =>
          this.stream.stream(tenantId).pipe(map((event) => ({ data: { tenantId, ...event } }))),
        )),
      ),
    );
  }
}
```

- [ ] **Step 7: Provide the catalog in AdminModule** — rewrite `apps/read-api/src/admin/admin.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { MongoService, RedisService, PrismaService, TenantCatalogService } from "@flashbite/shared";
import { RolesGuard } from "@flashbite/tenant-context";
import { Reflector } from "@nestjs/core";
import { SseModule } from "../sse/sse.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [SseModule],
  controllers: [AdminController],
  providers: [
    AdminService, MongoService, RedisService, RolesGuard, Reflector,
    PrismaService,
    { provide: TenantCatalogService, useFactory: (p: PrismaService) => new TenantCatalogService(p), inject: [PrismaService] },
  ],
})
export class AdminModule {}
```

- [ ] **Step 8: Run the tests** — `pnpm jest apps/read-api/test/tenants.e2e-spec.ts apps/read-api/test/admin.e2e-spec.ts` (expect PASS — the new tenants/guard spec, and the existing admin operator e2e still green over the catalog). If the admin e2e file has a different name, run the read-api admin/operator e2e that exists.

- [ ] **Step 9: Commit**
```bash
git add apps/read-api/src/app.module.ts apps/read-api/src/tenants apps/read-api/src/admin apps/read-api/test/tenants.e2e-spec.ts
git commit -m "feat(read-api): TenantGuard + GET /tenants; AdminService fan-out reads the catalog"
```

---

## Task 5: write-api adopts the guard

**Files:**
- Modify: `apps/write-api/src/app.module.ts`
- Test: `apps/write-api/test/tenant-guard.e2e-spec.ts`

**Interfaces:**
- Consumes: `TenantGuard` (Task 3), `TenantCatalogService` + `PrismaService` (shared).

- [ ] **Step 1: Write the failing e2e** — create `apps/write-api/test/tenant-guard.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestAuth } from "@flashbite/tenant-context/testing";
import { AppModule } from "../src/app.module";

describe("write-api TenantGuard (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it("rejects a write from a non-catalog tenant with 403", async () => {
    const token = await createTestAuth({ tenantId: "ghost-tenant", role: "customer", sub: "c1" });
    const res = await request(app.getHttpServer())
      .post("/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderId: "o-guard-1", customerId: "c1", items: [], totalAmount: 0 });
    expect(res.status).toBe(403);
  });
});
```
> NOTE: mirror the existing write-api e2e's auth-token setup (grep `createTestAuth` in `apps/write-api/test`). Use a POST route that exists; `/orders` is the canonical write route. The point is only that the guard rejects a non-catalog tenant before the handler runs.

- [ ] **Step 2: Run it, confirm it fails** — `pnpm jest apps/write-api/test/tenant-guard.e2e-spec.ts` (fails: guard not wired → 201/400, not 403).

- [ ] **Step 3: Wire the guard** — add to `apps/write-api/src/app.module.ts`: import `TenantGuard` from `@flashbite/tenant-context` and `PrismaService, TenantCatalogService` from `@flashbite/shared`; add to `providers` (alongside the existing `RolesGuard` APP_GUARD):
```ts
    PrismaService,
    { provide: TenantCatalogService, useFactory: (p: PrismaService) => new TenantCatalogService(p), inject: [PrismaService] },
    { provide: APP_GUARD, useFactory: (catalog: TenantCatalogService) => new TenantGuard(catalog), inject: [TenantCatalogService] },
```
(Keep the existing `TokenVerifier`, `Reflector`, and `RolesGuard` APP_GUARD providers.)

- [ ] **Step 4: Run the tests** — `pnpm jest apps/write-api/test/tenant-guard.e2e-spec.ts apps/write-api/test/dispatch.e2e-spec.ts` (expect PASS — guard rejects ghost tenant; existing write-api e2e for berlin still green). Run the other existing write-api e2e too if present.

- [ ] **Step 5: Commit**
```bash
git add apps/write-api/src/app.module.ts apps/write-api/test/tenant-guard.e2e-spec.ts
git commit -m "feat(write-api): TenantGuard rejects non-catalog tenants"
```

---

## Task 6: saga-worker dispatch center from the catalog

**Files:**
- Modify: `apps/saga-worker/src/dispatch-activities.ts`
- Modify: `apps/write-api/test/dispatch.e2e-spec.ts`, `apps/saga-worker/test/dispatch.e2e-spec.ts` (replace `CITY_CENTERS` import with a local fixture)

**Interfaces:**
- Consumes: `TenantCatalogService` (Task 2).

- [ ] **Step 1: Use the catalog for the dispatch center** — in `apps/saga-worker/src/dispatch-activities.ts`:
  - Add `TenantCatalogService` to the `@flashbite/shared` import; remove `CITY_CENTERS` and `type Tenant` from the `@flashbite/contracts` import (keep the other contracts imports).
  - Inside `createDispatchActivities(prisma, redis)`, before the returned object, add: `const catalog = new TenantCatalogService(prisma);`
  - In `selectNearestAvailableDriverActivity`, replace:
    ```ts
    const center = CITY_CENTERS[tenantId as Tenant];
    if (!center) return null;
    ```
    with:
    ```ts
    const center = await catalog.get(tenantId);
    if (!center) return null; // unknown tenant -> no driver to offer
    ```
    (the rest of the function — `redis.geosearch(... String(center.lng), String(center.lat) ...)` — is unchanged; `center.lng`/`center.lat` exist on `TenantView`).

- [ ] **Step 2: Fix the two dispatch e2e fixtures** — in BOTH `apps/write-api/test/dispatch.e2e-spec.ts` and `apps/saga-worker/test/dispatch.e2e-spec.ts`: remove `CITY_CENTERS` from the `@flashbite/contracts` import and define a local fixture near the top of the file:
```ts
const BERLIN_CENTER = { lng: 13.405, lat: 52.52 };
```
then replace every `CITY_CENTERS.berlin` with `BERLIN_CENTER`.

- [ ] **Step 3: Run the dispatch e2e** — `pnpm jest apps/saga-worker/test/dispatch.e2e-spec.ts apps/write-api/test/dispatch.e2e-spec.ts` (expect PASS — the dispatch flow now resolves the center from the seeded catalog).

- [ ] **Step 4: Commit**
```bash
git add apps/saga-worker/src/dispatch-activities.ts apps/write-api/test/dispatch.e2e-spec.ts apps/saga-worker/test/dispatch.e2e-spec.ts
git commit -m "feat(saga-worker): dispatch center from the tenant catalog"
```

---

## Task 7: identity seeds from the catalog; remove contracts constants; docs + full verification

**Files:**
- Modify: `apps/identity/src/seed-shared.ts`, `apps/identity/src/seed.ts`
- Modify: `packages/contracts/src/index.ts` (remove `TENANTS` + `CITY_CENTERS`; `Tenant` → `string`)
- Modify: `.env.example`, `docs/ARCHITECTURE.md`, `README.md`, the identity requests `.http` file

**Interfaces:**
- Consumes: `prisma.tenant` (Task 1).

- [ ] **Step 1: Seed users from the tenants table** — in `apps/identity/src/seed-shared.ts`: remove `export const TENANTS = [...]`. Add a helper and make `seedDrivers` take the slugs:
```ts
/** Active tenant slugs from the catalog table (the single source of truth). */
export async function tenantSlugs(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.tenant.findMany({ where: { status: "active" } });
  return rows.map((r) => r.slug);
}
```
Change `seedDrivers(prisma, passwordHash)` to `seedDrivers(prisma, passwordHash, slugs: string[])` and iterate `slugs` instead of `TENANTS` (the inner body — `driverUserId`, the upsert — is unchanged).

- [ ] **Step 2: Update seed.ts** — in `apps/identity/src/seed.ts`: replace the `TENANTS` import with `tenantSlugs`; after creating `prisma`, do `const slugs = await tenantSlugs(prisma);`; iterate `slugs` in the role-seed loop; pass `slugs` to `seedDrivers(prisma, passwordHash, slugs)`. (The operator upsert at the end is unchanged.) If `slugs` is empty, log a clear hint to run `seed:tenants` first.

- [ ] **Step 3: Remove the contracts constants + widen Tenant** — in `packages/contracts/src/index.ts`, delete the `export const TENANTS = ...` and the `export const CITY_CENTERS: Record<Tenant, GeoPoint> = {...}` blocks, and change `export type Tenant = (typeof TENANTS)[number];` to:
```ts
export type Tenant = string;
```
Keep `GeoPoint`, `TenantView`, and `NearbyDriver`.

- [ ] **Step 4: Typecheck the backend for stragglers** — run `pnpm jest packages/contracts apps/identity/test/auth.e2e-spec.ts` and `npx tsc --noEmit -p apps/read-api/tsconfig.json` (EXIT 0). If tsc flags any remaining backend reference to the removed `TENANTS`/`CITY_CENTERS`, fix that file to read the catalog (it should already be migrated by Tasks 4-6 — this is the safety net).

- [ ] **Step 5: Docs + env + requests** — ASCII only, match surrounding style:
  - `.env.example`: add `TENANT_CATALOG_TTL_MS=60000   # tenant catalog cache TTL (ms)` near the other config.
  - `docs/ARCHITECTURE.md`: add a bullet — the tenant catalog (`tenants` table + cached `TenantCatalogService`) is the runtime source of truth for the tenant list + metadata; `TenantGuard` validates each request's `tenantId` against the active catalog (operator exempt); adding/suspending a tenant is a DB change honored within the cache TTL; `GET /tenants` exposes it.
  - `README.md`: one-line mention (DB-backed tenant catalog + per-request tenant validation), beside the tenancy/identity bullets.
  - identity requests `.http` file (the one with `auth/login`): add `### Tenants (active catalog)\nGET {{readUrl}}/tenants` — reuse the file's read-api base-URL variable if present, else add the example to the read-api requests file.

- [ ] **Step 6: Full verification sweep** — run and confirm each (infra up; DB migrated + `seed:tenants` + `seed:users` run):
```bash
pnpm jest packages/shared/test/tenant-catalog.spec.ts packages/tenant-context/test/tenant.guard.spec.ts packages/shared/test/config.spec.ts packages/contracts
pnpm jest apps/read-api apps/write-api apps/saga-worker apps/identity
```
Expect: catalog + guard + config + contracts unit suites pass; read-api/write-api/saga-worker/identity e2e all pass (including the new tenants + guard specs and the existing admin/dispatch/auth e2e). If anything fails, STOP and report it with the failing output.

- [ ] **Step 7: Commit**
```bash
git add apps/identity/src/seed-shared.ts apps/identity/src/seed.ts packages/contracts/src/index.ts .env.example docs/ARCHITECTURE.md README.md
git add -A "**/*.http"
git commit -m "feat(tenants): seed from catalog; drop contracts TENANTS/CITY_CENTERS (Tenant=string); docs"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** `tenants` table + migration + GRANT + `seed:tenants` → Task 1; `TenantCatalogService` (cached, resilient, fail-closed) → Task 2; `TenantGuard` (operator bypass, no-context allow, 403/503) → Task 3; read-api guard + `GET /tenants` + AdminService fan-out → Task 4; write-api guard → Task 5; saga dispatch center from catalog + test fixtures → Task 6; identity seeds from catalog + contracts `Tenant`→`string` + remove `TENANTS`/`CITY_CENTERS` + docs + full sweep → Task 7. Frontends untouched (Slice B). ✓

**Ordering keeps the tree green:** the contracts constants are removed only in Task 7, after every backend consumer (admin Task 4, dispatch Task 6, identity Task 7) has been migrated; `TenantView` is added early (Task 1) since Tasks 2/4 need it.

**Type consistency:** `TenantCatalogService` ctor `(prisma: PrismaClient, ttlMs?)` — apps pass `PrismaService` (extends `PrismaClient`), worker/seeds pass `PrismaClient`; `list/get/isActive/refresh` signatures consistent across Tasks 2/4/6; `TenantView` shape (`slug/displayName/lng/lat/status`) consistent from contracts → catalog → controller; `TenantGuard(catalog)` single-arg ctor matches the `APP_GUARD` factories in Tasks 4/5 and the unit test in Task 3; the operator role string `"operator"` matches `ROLES.OPERATOR`.

**Constraints surfaced:** the `GRANT SELECT … TO flashbite_app` (Task 1) is the gotcha that otherwise fail-closes everything; fail-closed-cold / resilient-warm cache (Task 2) is tested incl. the empty-cold-cache throw; the operator principal's `tenantId="platform"` is deliberately not a catalog tenant and relies on the guard's operator bypass (Task 3).
