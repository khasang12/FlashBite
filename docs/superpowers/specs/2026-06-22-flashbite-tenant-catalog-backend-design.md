# Tenant catalog (backend) — design

**Goal:** Replace the hardcoded, triplicated `TENANTS = ["berlin","tokyo"]` constant with a **DB-backed tenant catalog** (a `tenants` table + a cached `TenantCatalogService`), so adding/suspending a tenant is a data change, not a code change — and add the TCS-style **per-request tenant validation** (the JWT's `tenantId` must be a real, active tenant). Backend-only; frontends keep their own constant until Slice B.

**Builds on:** Phase 2 identity/RLS (the JWT carries `tenantId`; `flashbite_app` is the restricted Postgres role), the ALS `AuthContext` in `@flashbite/tenant-context`, `AdminService`'s cross-tenant fan-out, and the saga dispatch activities. This is **Slice A** of the "full tenant catalog" work (Slice B = frontends consume the catalog). Inspired by the Atlassian Tenant-Context-Service article (catalog + per-request tenant resolution); the CQRS/DynamoDB/Kinesis/SNS machinery is YAGNI at this scale — see "Known simplifications." Branch `phase-tenant-catalog-backend` off `main`.

## Scope

In scope: a `tenants` table + migration + `seed:tenants`; a cached `TenantCatalogService` (`@flashbite/shared`); contracts `Tenant` union → `string` with `TENANTS`/`CITY_CENTERS` removed and a `TenantView` type added; a `TenantGuard` (per-request active-tenant check) in read-api + write-api; rewiring `AdminService`, the saga dispatch center lookup, and identity seeding to the catalog; a `GET /tenants` read endpoint.

Out of scope (Slice B / backlog): the 4 frontends consuming the catalog (they keep their own `TENANTS`/`CITY_CENTERS` constants in web-shared); cross-process cache invalidation via pub/sub; a tenant-admin CRUD UI; tenant onboarding workflow.

## Architecture & data flow

```
seed:tenants --upsert--> Postgres `tenants` (slug PK, display_name, lng, lat, status)
                              |
   TenantCatalogService (@flashbite/shared; one instance per process, built with PrismaService)
   - in-memory cache, TTL ~60s, manual refresh()
   - list(activeOnly=true) / get(slug) / isActive(slug) / refresh()
                              |
   read-api / write-api          read-api AdminService            saga-worker dispatch-activities
   TenantGuard (per request):    fan-out iterates catalog.list()  center = catalog.get(tenantId)
   JWT tenantId must be an        (Mongo + Redis geo per tenant);  (geo reference for driver offers)
   ACTIVE catalog tenant         GET /tenants -> TenantView[]
   else 403 (operator bypass)
```

The catalog is read-heavy / write-rare — each process caches it in memory with a short TTL plus a manual `refresh()`. Cross-process invalidation (the article's SNS broadcast) is replaced by the TTL; a suspend/add propagates within the TTL window.

## Data model

`tenants` table — shared Prisma schema (`packages/shared/prisma/schema.prisma`):

```prisma
model Tenant {
  slug        String   @id                    // "berlin" — equals the JWT tenantId
  displayName String   @map("display_name")   // "Berlin"
  lng         Float
  lat         Float
  status      String   @default("active")     // active | suspended
  createdAt   DateTime @default(now()) @map("created_at")
  @@map("tenants")
}
```

- **Not under RLS** — it is the global cross-tenant catalog (every process reads all rows), consistent with `users`. The migration must `GRANT SELECT ON "tenants" TO flashbite_app;` so the restricted role used by read-api/write-api/saga-worker can read it. Seeding runs on the superuser connection (INSERT/UPSERT), unaffected.
- `slug` (PK) equals the JWT `tenantId` — the join key for the guard and fan-out.
- `lng/lat` carry the city-center reference previously in `CITY_CENTERS`; `displayName`/`status` are new (status drives the suspend check).

**Seeding:** new `seed:tenants` (`apps/identity/src/seed-tenants.ts` + a `seed:tenants` package script) upserts `berlin` ("Berlin", `{13.405, 52.52}`, active) and `tokyo` ("Tokyo", `{139.7, 35.68}`, active). `db:setup` becomes `db:deploy && db:generate && seed:tenants && seed:users` (tenants first). `seed:users` stops using its own `TENANTS` const and iterates `catalog.list()`, making the table the single source of truth.

## Components

- **`TenantCatalogService`** (`packages/shared/src/tenant-catalog.ts`, exported from shared): `constructor(prisma, @Optional() ttlMs?)` (default 60000, `TENANT_CATALOG_TTL_MS`). In-memory cache (rows + `loadedAt`); `ensureFresh()` reloads via `prisma.tenant.findMany()` when empty or stale, **keeps a non-empty cache on a DB error** (resilient) but **throws when the cache is empty** (fail-closed cold start). API: `list(activeOnly=true): Promise<TenantView[]>`, `get(slug): Promise<TenantView | null>`, `isActive(slug): Promise<boolean>`, `refresh(): Promise<void>`.
- **`contracts`** (`packages/contracts/src/index.ts`): remove `TENANTS` and `CITY_CENTERS`; `export type Tenant = string`; keep `GeoPoint`; add `export interface TenantView { slug: string; displayName: string; lng: number; lat: number; status: string }`.
- **`TenantGuard`** (`packages/tenant-context/src/tenant.guard.ts`, beside `RolesGuard`; tenant-context already depends on shared, so it can DI-inject `TenantCatalogService` — no new package dep, no cycle since shared does not import tenant-context): no auth context → allow; `role === operator` → allow; else `403` unless `await isActive(getTenantId())`. Registered as `APP_GUARD` in read-api + write-api app modules (each provides `TenantCatalogService` + `PrismaService`).
- **Backend consumer rewrites:**
  - `apps/saga-worker/src/dispatch-activities.ts` — `CITY_CENTERS[tenantId as Tenant]` → `await catalog.get(tenantId)` (its `{lng,lat}`); a catalog instance from the worker's `PrismaService`; null → throw a clear error.
  - `apps/read-api/src/admin/admin.service.ts` + `admin.controller.ts` — `TENANTS.map`/`CITY_CENTERS[...]` → `(await catalog.list())` + the row's `lng/lat`; inject `TenantCatalogService`.
  - `apps/identity/src/seed.ts` + `seed-shared.ts` — drop the local `TENANTS`; iterate `catalog.list()`.
  - `apps/write-api/test/dispatch.e2e-spec.ts` + `apps/saga-worker/test/dispatch.e2e-spec.ts` — replace `CITY_CENTERS.berlin` with a local `{ lng: 13.405, lat: 52.52 }` fixture.
- **`GET /tenants`** — new `TenantsController` in read-api returning `catalog.list()` (active `TenantView[]`) to any authenticated tenant user; consumed by Slice B.
- **config** (`packages/shared/src/config.ts`): add `tenantCatalogTtlMs` (`TENANT_CATALOG_TTL_MS`, default 60000).

## Error handling

- Unknown/`suspended` tenant (non-operator) → `403`.
- `operator` role → bypasses the single-tenant check.
- No auth context (health, pre-auth) → guard allows (auth stays the middleware's responsibility).
- Cold start, DB unreachable, empty cache → `ensureFresh()` throws → guard denies with `503`. Warm cache survives later DB blips (resilient).
- Empty `tenants` table (un-seeded) → all non-operator requests 403 — expected; `db:setup` seeds first.
- Suspend/add propagates within the TTL (<=60s) across processes — the documented eventual-consistency window.
- `catalog.get(tenantId)` null in the dispatch activity → throw rather than offer with a bogus center.

## Testing

- **shared (Jest, live DB):** `TenantCatalogService` — `list`/`get`/`isActive` over seeded rows; `activeOnly` filters a suspended tenant; `refresh()` reflects an inserted/suspended change; cold start with empty table throws (fail-closed).
- **tenant-context (Jest, mocked catalog):** `TenantGuard` — active allowed; suspended/unknown → `ForbiddenException`; `operator` bypass; no-context allow.
- **read-api:** `GET /tenants` returns active `TenantView[]`; existing operator/admin e2e still pass over the catalog fan-out; a JWT with a non-active `tenantId` → 403.
- **write-api / saga-worker:** existing dispatch e2e still pass (seeded tenants; center from the catalog).
- **Full sweep:** migrate + `seed:tenants` + Jest across identity / read-api / write-api / saga-worker / shared / tenant-context / contracts.

## Success criteria

1. Adding or suspending a tenant is a DB row change (no code edit) honored by the fan-out, the dispatch center, and per-request validation within the TTL.
2. A request whose JWT `tenantId` is unknown or suspended is rejected `403` (operator exempt).
3. `Tenant` is `string`; `TENANTS` and `CITY_CENTERS` are gone from `@flashbite/contracts`; backend reads tenant data from the catalog.
4. All backend suites + typechecks pass; frontends are untouched (still on their own constant — Slice B).

## Known simplifications (backlog)

- Cache invalidation is a per-process TTL, not a cross-process broadcast (the article's SNS) — acceptable at this scale; documented eventual-consistency window.
- No tenant-admin CRUD UI / onboarding workflow — tenants are managed via `seed:tenants` / SQL.
- Slice B (frontends consume the catalog: web-shared `getTenants()` + dynamic selectors/city-centers, removing the web-shared `TENANTS`/`CITY_CENTERS` constants) is a separate spec.
- The article's full CQRS read/write split, DynamoDB single-source-of-truth, and Kinesis cross-region replication are over-engineering for a single-region, few-tenant showcase.
