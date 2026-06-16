# Phase 2 — S3 (Operator Console API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An authenticated **cross-tenant** operator console API in read-api so the admin dashboard stops faking tenancy via the header — `GET /admin/orders`, `GET /admin/drivers`, `GET /admin/orders/stream`, all behind an `operator` role.

**Architecture:** A new `operator` role (one seeded `operator@flashbite.test`, sentinel `tenantId: "platform"`). A read-api `AdminModule` whose controller is guarded by the existing `RolesGuard` + `@Roles("operator")`. Its service queries **across all tenants**: Mongo `orders` with no tenant filter; Redis geo looped over each tenant's city center; SSE by merging every tenant's order-event stream. These endpoints read Mongo + Redis only (no Postgres / no RLS interaction). Aggregation (GMV, charts) stays client-side.

**Tech Stack:** NestJS 10, RxJS (SSE merge), MongoDB, Redis geo, jose (test tokens), Jest.

**Scope:** S3 ONLY. No RLS (S2), no JWT plumbing changes (S1 done), no frontend (the web-admin swap to `/admin/*` is S4). This slice ships the backend API + operator seed + tests; the admin UI keeps its current fan-out until S4.

**Branch:** `phase-2-s3-operator-api` off `main` (create it; design spec already on main). Independent of S2 — both branch from main and can merge in any order. (S3 touches read-api + identity seed + contracts; S2 touches the write plane + Postgres — no file overlap.)

**Key facts (verified):**
- `@flashbite/tenant-context` exports `getRole()`, `getAuthContext()`, `Roles`, `RolesGuard`, `AuthMiddleware`, `createTestAuth` (via `@flashbite/tenant-context/testing`). read-api already applies `AuthMiddleware` (`.exclude("health")`) globally, so `/admin/*` is authenticated; the controller adds `@UseGuards(RolesGuard)` + `@Roles("operator")`.
- read-api has NO global RolesGuard (S1 only added it to write-api) → use `@UseGuards(RolesGuard)` on the admin controller.
- Mongo orders: collection `READ_COLLECTIONS.ORDERS = "orders"`, `_id = "${tenantId}:${orderId}"`, every doc carries `tenantId`. Cross-tenant list = `find({}).sort({updatedAt:-1}).limit(N)`.
- Redis geo: `driverGeoKey(tenant)` = `tenant:{<t>}:drivers:geo`; per-tenant `GEOSEARCH FROMLONLAT <center> BYRADIUS <r> km`.
- `OrderStreamService` (in `apps/read-api/src/sse/`) holds `Map<tenantId, Subject>` fed by `SseFeederService` (consumes ALL tenants from `order-events`). Cross-tenant SSE = `merge(stream("berlin"), stream("tokyo"))`. SseModule must export `OrderStreamService` so AdminModule can inject the SAME instance the feeder writes to.
- `TENANTS` + `CITY_CENTERS` currently live in `packages/web-shared` (frontend). read-api must NOT import web-shared → add `TENANTS` + `CITY_CENTERS` to `@flashbite/contracts` (backend-safe) and use them in read-api.
- Identity seed (`apps/identity/src/seed.ts`) loops `TENANTS × ROLES`. `User.tenantId` is a plain `String` (no FK) → sentinel `"platform"` needs no schema change. `TokenService.sign` embeds whatever `tenantId`/`role` the user row has.
- OrderView shape (from contracts): `{ tenantId, orderId, customerId, items, totalAmount, status, version, updatedAt, cancelReason? }`.

---

## File Structure

- Modify: `packages/contracts/src/index.ts` — add `TENANTS`, `CITY_CENTERS`, and a shared `NearbyDriver` type.
- Modify: `apps/identity/src/seed.ts` — seed `operator@flashbite.test` (role `operator`, tenant `platform`).
- Create: `apps/read-api/src/admin/admin.service.ts` — cross-tenant orders + drivers + merged stream.
- Create: `apps/read-api/src/admin/admin.controller.ts` — `@Roles("operator")` + `@UseGuards(RolesGuard)`; GET orders/drivers/stream.
- Create: `apps/read-api/src/admin/admin.module.ts` — wires service/controller; imports SseModule; provides Mongo/Redis/RolesGuard.
- Modify: `apps/read-api/src/sse/sse.module.ts` — export `OrderStreamService`.
- Modify: `apps/read-api/src/app.module.ts` — import `AdminModule`.
- Create: `apps/read-api/test/admin.e2e-spec.ts` — operator cross-tenant; 403 non-operator; 401 no token.
- Modify: `apps/write-api/requests.http` — operator login + `/admin/*` examples.

---

## Task 1: contracts — TENANTS, CITY_CENTERS, NearbyDriver

**Files:** `packages/contracts/src/index.ts`, `packages/contracts/src/index.spec.ts` (or the existing contracts spec)

**Context:** read-api needs the tenant list + city centers without importing the frontend package. Put them in contracts. Values must match web-shared's (`berlin: 13.405,52.52`; `tokyo: 139.7,35.68`).

- [ ] **Step 1: Failing test** — find the contracts test file (e.g. `packages/contracts/src/*.spec.ts`); if none, create `packages/contracts/src/geo.spec.ts`:

```ts
import { TENANTS, CITY_CENTERS } from "./index";

describe("tenants + city centers", () => {
  it("lists the known tenants", () => {
    expect(TENANTS).toEqual(["berlin", "tokyo"]);
  });
  it("has a city center per tenant", () => {
    for (const t of TENANTS) {
      expect(CITY_CENTERS[t]).toEqual(expect.objectContaining({ lng: expect.any(Number), lat: expect.any(Number) }));
    }
    expect(CITY_CENTERS.berlin).toEqual({ lng: 13.405, lat: 52.52 });
    expect(CITY_CENTERS.tokyo).toEqual({ lng: 139.7, lat: 35.68 });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm exec jest packages/contracts/src/geo.spec.ts`

- [ ] **Step 3: Implement** — add to `packages/contracts/src/index.ts`:

```ts
export const TENANTS = ["berlin", "tokyo"] as const;
export type Tenant = (typeof TENANTS)[number];

export interface GeoPoint {
  lng: number;
  lat: number;
}

export const CITY_CENTERS: Record<Tenant, GeoPoint> = {
  berlin: { lng: 13.405, lat: 52.52 },
  tokyo: { lng: 139.7, lat: 35.68 },
};

export interface NearbyDriver {
  driverId: string;
  distanceKm: number;
  lng: number;
  lat: number;
}
```

(If `GeoPoint` already exists in contracts, reuse it and don't redeclare.)

- [ ] **Step 4: Run, expect PASS** — `pnpm exec jest packages/contracts/src/geo.spec.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/geo.spec.ts
git commit -m "feat(contracts): TENANTS + CITY_CENTERS + NearbyDriver (backend-safe)"
```

---

## Task 2: identity — seed the operator

**Files:** `apps/identity/src/seed.ts`, `apps/identity/test/*` (add an assertion if a seed test exists; otherwise covered by S3 e2e)

**Context:** Add one platform operator account alongside the per-tenant users. Sentinel `tenantId: "platform"` (no schema change — `tenantId` is a free string). Roles array stays as-is for the per-tenant matrix; operator is seeded separately.

- [ ] **Step 1: Implement** — in `apps/identity/src/seed.ts`, after the existing `for (tenant) for (role)` upsert loop, add:

```ts
  // Platform operator: cross-tenant console principal (not pinned to a tenant).
  await prisma.user.upsert({
    where: { email: "operator@flashbite.test" },
    update: { tenantId: "platform", role: "operator", passwordHash },
    create: { tenantId: "platform", role: "operator", email: "operator@flashbite.test", passwordHash },
  });
```

(`passwordHash` is the same dev-password hash variable the loop already uses.)

- [ ] **Step 2: Run the seed against infra**

Run: `pnpm infra:up && pnpm db:deploy && pnpm seed:users`
Expected: completes; `operator@flashbite.test` upserted. Verify:
```bash
docker exec $(docker compose -f infra/docker-compose.yml ps -q postgres) \
  psql -U flashbite -d flashbite_write -c "SELECT email, tenant_id, role FROM users WHERE role='operator';"
```
Expected: one row `operator@flashbite.test | platform | operator`.

- [ ] **Step 3: Commit**

```bash
git add apps/identity/src/seed.ts
git commit -m "feat(identity): seed platform operator user (role=operator)"
```

---

## Task 3: AdminService — cross-tenant orders + drivers

**Files:** `apps/read-api/src/admin/admin.service.ts`

**Context:** Reads Mongo + Redis with NO tenant scoping (this is the deliberate cross-tenant principal). Never calls `getTenantId()`. Mirrors what the admin FE aggregates today.

- [ ] **Step 1: Implement the service**

Create `apps/read-api/src/admin/admin.service.ts`:

```ts
import { Injectable } from "@nestjs/common";
import { MongoService, RedisService } from "@flashbite/shared";
import {
  READ_COLLECTIONS,
  TENANTS,
  CITY_CENTERS,
  type OrderView,
  type NearbyDriver,
  driverGeoKey,
} from "@flashbite/contracts";

const ADMIN_NEARBY_RADIUS_KM = 50; // wide radius so the operator sees all active drivers per city

export interface TenantNearbyDriver extends NearbyDriver {
  tenantId: string;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly mongo: MongoService,
    private readonly redis: RedisService,
  ) {}

  /** Recent orders across ALL tenants (no tenant filter), newest first. */
  async listAllOrders(limit = 200): Promise<OrderView[]> {
    const docs = await this.mongo.db
      .collection(READ_COLLECTIONS.ORDERS)
      .find({})
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => ({
      tenantId: doc.tenantId,
      orderId: doc.orderId,
      customerId: doc.customerId,
      items: doc.items ?? [],
      totalAmount: doc.totalAmount,
      status: doc.status,
      version: doc.version,
      updatedAt: doc.updatedAt,
      ...(doc.cancelReason ? { cancelReason: doc.cancelReason } : {}),
    }));
  }

  /** Live drivers across ALL tenants: GEOSEARCH each tenant's geo set around its city center. */
  async listAllDrivers(): Promise<TenantNearbyDriver[]> {
    const perTenant = await Promise.all(
      TENANTS.map(async (tenantId) => {
        const c = CITY_CENTERS[tenantId];
        const raw = (await this.redis.cluster.geosearch(
          driverGeoKey(tenantId),
          "FROMLONLAT",
          String(c.lng),
          String(c.lat),
          "BYRADIUS",
          String(ADMIN_NEARBY_RADIUS_KM),
          "km",
          "ASC",
          "WITHDIST",
          "WITHCOORD",
        )) as Array<[string, string, [string, string]]>;
        return raw.map(([driverId, dist, [dlng, dlat]]) => ({
          tenantId,
          driverId,
          distanceKm: Number(dist),
          lng: Number(dlng),
          lat: Number(dlat),
        }));
      }),
    );
    return perTenant.flat();
  }
}
```

(Match the exact `geosearch` argument style used in `apps/read-api/src/drivers/drivers.controller.ts` — confirm whether it passes numbers or strings and mirror it; the raw-tuple cast shape must match what that controller uses.)

- [ ] **Step 2: Commit** (controller + tests come next; commit the service alone is fine, or fold into Task 5's commit. Prefer committing after the controller compiles — defer commit to Task 5.)

---

## Task 4: SseModule exports OrderStreamService

**Files:** `apps/read-api/src/sse/sse.module.ts`

**Context:** The admin merged stream must subscribe to the SAME `OrderStreamService` instance that `SseFeederService` feeds. Export it from SseModule so AdminModule (which imports SseModule) injects that instance.

- [ ] **Step 1: Read `apps/read-api/src/sse/sse.module.ts`** and add `OrderStreamService` to its `exports` array (keep all existing providers/exports). If `OrderStreamService` is not already a provider there, ensure it is provided AND exported. Example shape:

```ts
@Module({
  controllers: [/* existing, e.g. MerchantSseController */],
  providers: [/* existing, e.g. */ OrderStreamService, SseFeederService],
  exports: [OrderStreamService],
})
export class SseModule {}
```

- [ ] **Step 2: Quick compile check** — `pnpm exec jest apps/read-api/test/sse.e2e-spec.ts` (existing SSE e2e should still pass; confirms the module still wires).
Expected: PASS (no behavior change).

- [ ] **Step 3: Commit** (fold into Task 5's commit, or commit now):

```bash
git add apps/read-api/src/sse/sse.module.ts
git commit -m "refactor(read-api): export OrderStreamService from SseModule (for admin stream)"
```

---

## Task 5: AdminController + AdminModule + wire into app

**Files:** `apps/read-api/src/admin/admin.controller.ts`, `apps/read-api/src/admin/admin.module.ts`, `apps/read-api/src/app.module.ts`

**Context:** Controller is operator-guarded. The merged SSE tags each event with its tenant. `MessageEvent` is `@nestjs/common`'s SSE shape. Mongo/Redis services are provided in AdminModule (own instances are fine — they connect on init like elsewhere); `OrderStreamService` comes from the imported SseModule (shared instance).

- [ ] **Step 1: Controller**

Create `apps/read-api/src/admin/admin.controller.ts`:

```ts
import { Controller, Get, Sse, UseGuards, MessageEvent } from "@nestjs/common";
import { Observable, merge, map } from "rxjs";
import { Roles, RolesGuard } from "@flashbite/tenant-context";
import { TENANTS, type OrderView } from "@flashbite/contracts";
import { AdminService, type TenantNearbyDriver } from "./admin.service";
import { OrderStreamService } from "../sse/order-stream.service";

@Controller("admin")
@UseGuards(RolesGuard)
@Roles("operator")
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly stream: OrderStreamService,
  ) {}

  @Get("orders")
  listOrders(): Promise<OrderView[]> {
    return this.admin.listAllOrders();
  }

  @Get("drivers")
  listDrivers(): Promise<TenantNearbyDriver[]> {
    return this.admin.listAllDrivers();
  }

  @Sse("orders/stream")
  ordersStream(): Observable<MessageEvent> {
    // merge every tenant's order-event stream, tagging each event with its tenant.
    const streams = TENANTS.map((tenantId) =>
      this.stream.stream(tenantId).pipe(map((event) => ({ data: { tenantId, ...event } }) as MessageEvent)),
    );
    return merge(...streams);
  }
}
```

(Confirm the `OrderStreamService.stream(tenantId)` return type + the `MessageEvent` import path match what `merchant-sse.controller.ts` uses; mirror that controller's import style.)

- [ ] **Step 2: Module**

Create `apps/read-api/src/admin/admin.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { MongoService, RedisService } from "@flashbite/shared";
import { RolesGuard } from "@flashbite/tenant-context";
import { Reflector } from "@nestjs/core";
import { SseModule } from "../sse/sse.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [SseModule],
  controllers: [AdminController],
  providers: [AdminService, MongoService, RedisService, RolesGuard, Reflector],
})
export class AdminModule {}
```

(If `RolesGuard` fails to resolve `Reflector` under DI — the same dual-instance caveat noted in S1 — fall back to the proven S1 pattern: provide it via `{ provide: APP_GUARD ... }` is NOT wanted here (that would guard all read-api routes); instead keep `@UseGuards(RolesGuard)` and ensure `Reflector` + `RolesGuard` are in `providers` as above. The explicit `Reflector` provider mirrors S1's write-api fix.)

- [ ] **Step 3: Wire into app.module**

Edit `apps/read-api/src/app.module.ts` — add `AdminModule` to `imports`:

```ts
import { AdminModule } from "./admin/admin.module";
// ...
@Module({
  imports: [OrdersModule, SseModule, DriversModule, AdminModule],
  controllers: [HealthController],
  providers: [TokenVerifier],
})
```

(AuthMiddleware already applies to `*` except health, so `/admin/*` is authenticated; the controller's `@Roles("operator")` adds the 403 gate.)

- [ ] **Step 4: Compile/smoke**

Run: `pnpm exec jest apps/read-api/test/health.e2e-spec.ts`
Expected: PASS (app boots with AdminModule wired).

- [ ] **Step 5: Commit**

```bash
git add apps/read-api/src/admin/ apps/read-api/src/sse/sse.module.ts apps/read-api/src/app.module.ts
git commit -m "feat(read-api): operator console API (/admin/orders, /admin/drivers, /admin/orders/stream)"
```

---

## Task 6: Operator API e2e

**Files:** `apps/read-api/test/admin.e2e-spec.ts`

**Context:** Use the S1 test-auth pattern (`createTestAuth` + `overrideProvider(TokenVerifier)`). Mint an `operator` token (tenantId `platform`) and a non-operator token (e.g. `merchant`). Seed cross-tenant orders directly into Mongo (mirror how `merchant-orders.e2e-spec.ts` seeds) so `/admin/orders` returns both tenants. Assert operator sees both tenants; non-operator → 403; no token → 401.

- [ ] **Step 1: Write the test**

Create `apps/read-api/test/admin.e2e-spec.ts`:

```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { MongoService } from "@flashbite/shared";
import { READ_COLLECTIONS } from "@flashbite/contracts";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";

describe("read-api operator console (e2e)", () => {
  let app: INestApplication;
  let mongo: MongoService;
  let auth: TestAuth;
  let operator: string;
  let merchant: string;

  const seedOrder = async (tenantId: string) => {
    const orderId = randomUUID();
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).insertOne({
      _id: `${tenantId}:${orderId}` as never,
      tenantId,
      orderId,
      customerId: "c-1",
      items: [{ sku: "pizza", qty: 1, price: 1200 }],
      totalAmount: 1200,
      status: "PLACED",
      version: 1,
      updatedAt: new Date().toISOString(),
    } as never);
    return orderId;
  };

  beforeAll(async () => {
    auth = await createTestAuth();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    mongo = app.get(MongoService);
    operator = await auth.mint({ tenantId: "platform", role: "operator", sub: "op-1" });
    merchant = await auth.mint({ tenantId: "berlin", role: "merchant", sub: "m-1" });
  });

  afterAll(async () => {
    await app.close();
  });

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it("operator sees orders across all tenants", async () => {
    const berlinId = await seedOrder("berlin");
    const tokyoId = await seedOrder("tokyo");
    const res = await request(app.getHttpServer()).get("/admin/orders").set(bearer(operator));
    expect(res.status).toBe(200);
    const ids = res.body.map((o: { orderId: string }) => o.orderId);
    expect(ids).toEqual(expect.arrayContaining([berlinId, tokyoId]));
    const tenants = new Set(res.body.map((o: { tenantId: string }) => o.tenantId));
    expect(tenants.has("berlin")).toBe(true);
    expect(tenants.has("tokyo")).toBe(true);
  });

  it("operator can list drivers across tenants (shape)", async () => {
    const res = await request(app.getHttpServer()).get("/admin/drivers").set(bearer(operator));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // each entry (if any) is tagged with a tenant
    for (const d of res.body) {
      expect(typeof d.tenantId).toBe("string");
      expect(typeof d.driverId).toBe("string");
    }
  });

  it("rejects a non-operator role (403)", async () => {
    const res = await request(app.getHttpServer()).get("/admin/orders").set(bearer(merchant));
    expect(res.status).toBe(403);
  });

  it("rejects a request with no token (401)", async () => {
    const res = await request(app.getHttpServer()).get("/admin/orders");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run**

Run: `pnpm infra:up && pnpm exec jest apps/read-api/test/admin.e2e-spec.ts`
Expected: PASS (4 tests). If the orders test sees stale cross-tenant data from other suites, assert via `arrayContaining` (already done) rather than exact length. If 403 returns 401 or vice-versa, check the guard wiring (Task 5).

- [ ] **Step 3: Commit**

```bash
git add apps/read-api/test/admin.e2e-spec.ts
git commit -m "test(read-api): operator console e2e — cross-tenant orders/drivers, 403/401 gates"
```

---

## Task 7: requests.http examples + full verification

**Files:** `apps/write-api/requests.http`

- [ ] **Step 1: Add operator examples**

In `apps/write-api/requests.http`, in the Identity section, add an operator login + admin calls (match the file's existing comment/format style):

```
### Log in as the platform operator (cross-tenant console). Expect 201.
# @name loginOperator
POST {{identityUrl}}/auth/login
Content-Type: application/json

{
  "email": "operator@flashbite.test",
  "password": "{{seedPassword}}"
}

### Operator: all orders across every tenant. Expect 200 OrderView[] spanning berlin + tokyo.
GET {{readUrl}}/admin/orders
Authorization: Bearer {{loginOperator.response.body.$.accessToken}}

### Operator: live drivers across every tenant (tagged by tenantId). Expect 200.
GET {{readUrl}}/admin/drivers
Authorization: Bearer {{loginOperator.response.body.$.accessToken}}

### Operator SSE: merged order-event stream across all tenants. Stays open.
GET {{readUrl}}/admin/orders/stream
Authorization: Bearer {{loginOperator.response.body.$.accessToken}}
Accept: text/event-stream

### A non-operator token on /admin -> 403 (use the merchant login from above).
GET {{readUrl}}/admin/orders
Authorization: Bearer {{login.response.body.$.accessToken}}
```

- [ ] **Step 2: Full verification**

Run: `pnpm infra:up && pnpm db:deploy && pnpm seed:users && pnpm test`
Expected: PASS across the whole backend suite, including the new contracts geo spec and the operator e2e. Report totals.

- [ ] **Step 3: Commit**

```bash
git add apps/write-api/requests.http
git commit -m "docs(write-api): operator console (/admin/*) request examples"
```

---

## Self-review notes (coverage check)

- **operator role + seed** → Task 2.
- **TENANTS/CITY_CENTERS in a backend-safe package** → Task 1.
- **GET /admin/orders cross-tenant** → Tasks 3, 5.
- **GET /admin/drivers cross-tenant (loop city centers)** → Tasks 3, 5.
- **GET /admin/orders/stream merged SSE** → Tasks 4, 5.
- **operator-guarded (403 non-operator, 401 no token)** → Tasks 5, 6.
- **examples** → Task 7.
- **Out of scope:** no RLS, no JWT changes, no web-admin FE swap (S4); aggregation stays client-side.

## Notes for the executor

- read-api reads Mongo + Redis only — no Postgres, so S2's RLS is irrelevant here; this slice is independent of S2.
- Never call `getTenantId()` in admin code paths (the operator token's tenantId is the sentinel `"platform"`); use `getRole()` via `RolesGuard`.
- If `RolesGuard` DI for `Reflector` misbehaves in read-api (the S1 dual-instance caveat), mirror S1's fix: ensure `Reflector` is an explicit provider in `AdminModule` (already in the Task 5 module). Do not register a global APP_GUARD in read-api (it would force a role on every route, breaking open reads).
- Seed must run (`pnpm seed:users`) for the manual requests.http operator login; the e2e mint their own tokens and don't need the seed.
- `pnpm infra:up` (Mongo + Redis) is required for the operator e2e.
