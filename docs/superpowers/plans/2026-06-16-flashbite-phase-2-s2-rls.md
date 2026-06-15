# Phase 2 — S2 (Postgres Row-Level Security) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce tenant isolation at the database layer: the write plane (`event_store` + `outbox`) gets Postgres Row-Level Security so a tenant can never read or write another tenant's rows, even if app code has a bug.

**Architecture:** A restricted, non-superuser Postgres role `flashbite_app` is created by a migration; **write-api** and **saga-worker** connect as it (via a new `APP_DATABASE_URL`), and every write transaction sets `app.tenant_id` as its first statement. RLS policies on `event_store`/`outbox` use `current_setting('app.tenant_id', true)` for both `USING` (read) and `WITH CHECK` (write). The **outbox-poller**, **migrations**, and **identity** keep the existing superuser `DATABASE_URL` — superusers bypass RLS, so the poller still reads every tenant's pending rows.

**Tech Stack:** Postgres 16, Prisma 5 (raw SQL migration + `set_config` in interactive transactions), NestJS 10, Jest.

**Scope:** S2 ONLY. No JWT/auth changes (done in S1), no operator API (S3), no frontend (S4). RLS covers `event_store` + `outbox` only; `users` and `processed_events` are intentionally excluded (login needs cross-tenant user lookup; `processed_events` is out of scope).

**Branch:** `phase-2-s2-rls` off `main` (create it; the design spec at `docs/superpowers/specs/2026-06-15-flashbite-phase-2bcd-jwt-rls-operator-design.md` is already on main).

**Key facts (verified):**
- `flashbite` is a **superuser** (created via `POSTGRES_USER`) → it bypasses RLS entirely. So RLS only bites when connecting as the non-superuser `flashbite_app`. This is why write-api/saga must use `APP_DATABASE_URL` and the poller (superuser) correctly sees all tenants.
- `PrismaService` (`packages/shared/src/prisma.service.ts`) currently calls `super()` with no args (URL only from `DATABASE_URL` env). It must accept an optional URL so write-api can connect as `flashbite_app`.
- Two write paths: `apps/write-api/src/orders/orders.service.ts` (`this.prisma.$transaction`) and `packages/shared/src/event-store.ts` `appendEvent` (`prisma.$transaction`, used by saga-worker). Both already use interactive transactions — inject `set_config` as the first statement.
- `apps/saga-worker/src/main.ts` does `new PrismaClient()` (no args); `apps/outbox-poller/src/main.ts` does `new PrismaService()` (no args, stays superuser).
- `jest.setup.cjs` loads `.env` into `process.env`, so `APP_DATABASE_URL` added to `.env` reaches tests.
- Migrations are plain SQL, run via `pnpm db:deploy` as the superuser `DATABASE_URL` — safe for `CREATE ROLE`/`GRANT`/`ALTER TABLE ... ENABLE RLS`/`CREATE POLICY`.

---

## File Structure

- Modify: `packages/shared/src/config.ts` — add `appDatabaseUrl`.
- Modify: `packages/shared/src/config.spec.ts` — assert default/override.
- Modify: `packages/shared/src/prisma.service.ts` — optional connection-URL constructor.
- Modify: `apps/write-api/src/orders/orders.module.ts` — provide `PrismaService` via a factory using `appDatabaseUrl`.
- Modify: `apps/write-api/src/orders/orders.service.ts` — `set_config('app.tenant_id', …, true)` first in the write transaction.
- Modify: `packages/shared/src/event-store.ts` — `set_config` first in `appendEvent`'s transaction.
- Modify: `apps/saga-worker/src/main.ts` — construct `PrismaClient` with `appDatabaseUrl`.
- Create: `packages/shared/prisma/migrations/20260616000000_rls_event_store_outbox/migration.sql` — role + grants + RLS policies.
- Create: `packages/shared/test/rls.e2e-spec.ts` — RLS isolation integration test (connects as `flashbite_app`).
- Modify: `.env.example` — document `APP_DATABASE_URL` + the `flashbite_app` dev password.
- Modify: `README.md` — note the restricted role in the run/setup section.

---

## Task 1: Config — `appDatabaseUrl`

**Files:** `packages/shared/src/config.ts`, `packages/shared/src/config.spec.ts`

- [ ] **Step 1: Failing test** — add to `packages/shared/src/config.spec.ts` inside the existing describe:

```ts
  it("uses APP_DATABASE_URL when set, else falls back to DATABASE_URL", () => {
    const withApp = loadConfig({ DATABASE_URL: "postgres://owner", APP_DATABASE_URL: "postgres://app" });
    expect(withApp.appDatabaseUrl).toBe("postgres://app");
    const noApp = loadConfig({ DATABASE_URL: "postgres://owner" });
    expect(noApp.appDatabaseUrl).toBe("postgres://owner");
  });
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm exec jest packages/shared/src/config.spec.ts -t APP_DATABASE_URL`

- [ ] **Step 3: Implement** — in `packages/shared/src/config.ts`:
  - Add to `AppConfig`: `appDatabaseUrl: string;` (after `databaseUrl`).
  - In the `loadConfig` return object, after `databaseUrl,` add: `appDatabaseUrl: env.APP_DATABASE_URL ?? databaseUrl,`

- [ ] **Step 4: Run, expect PASS** — `pnpm exec jest packages/shared/src/config.spec.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/config.ts packages/shared/src/config.spec.ts
git commit -m "feat(shared): add APP_DATABASE_URL config (restricted RLS role)"
```

---

## Task 2: PrismaService — optional connection URL

**Files:** `packages/shared/src/prisma.service.ts`

**Context:** Prisma allows overriding the datasource URL at construction via `new PrismaClient({ datasources: { db: { url } } })`. We add an optional ctor arg so write-api can connect as `flashbite_app`. No-arg construction (poller, identity, tests) is unchanged — it reads `DATABASE_URL`.

- [ ] **Step 1: Failing test** — create `packages/shared/src/prisma.service.spec.ts`:

```ts
import { PrismaService } from "./prisma.service";

describe("PrismaService", () => {
  it("constructs without a url (defaults to DATABASE_URL env)", () => {
    const svc = new PrismaService();
    expect(svc).toBeInstanceOf(PrismaService);
  });

  it("accepts an explicit connection url", () => {
    const svc = new PrismaService("postgresql://flashbite_app:pw@localhost:5434/flashbite_write");
    expect(svc).toBeInstanceOf(PrismaService);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (the second test errors: ctor takes no args / TS arity) — `pnpm exec jest packages/shared/src/prisma.service.spec.ts`

- [ ] **Step 3: Implement** — replace `packages/shared/src/prisma.service.ts`:

```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * @param url optional connection string. When provided, overrides the
   * datasource url (used to connect as the restricted `flashbite_app` role for
   * RLS). When omitted, Prisma reads DATABASE_URL from the environment.
   */
  constructor(url?: string) {
    super(url ? { datasources: { db: { url } } } : undefined);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm exec jest packages/shared/src/prisma.service.spec.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/prisma.service.ts packages/shared/src/prisma.service.spec.ts
git commit -m "feat(shared): PrismaService accepts an optional connection url"
```

---

## Task 3: RLS migration (role + grants + policies)

**Files:** `packages/shared/prisma/migrations/20260616000000_rls_event_store_outbox/migration.sql`

**Context:** A pure-SQL migration (no schema model change). It runs as the superuser `DATABASE_URL` via `pnpm db:deploy`. The `flashbite_app` role is `NOSUPERUSER NOBYPASSRLS` so RLS applies to it. Policies compare `tenant_id` to the per-transaction GUC `app.tenant_id` (set via `set_config(..., true)` = transaction-local). `current_setting('app.tenant_id', true)` returns NULL when unset → comparison fails → fail-closed (no rows / blocked insert). The password here is dev-only (matches the Postgres dev password style already in `infra/docker-compose.yml`); never a real secret.

- [ ] **Step 1: Create the migration SQL**

Create `packages/shared/prisma/migrations/20260616000000_rls_event_store_outbox/migration.sql`:

```sql
-- Restricted application role for RLS-enforced tenant isolation on the write plane.
-- The existing `flashbite` role is a SUPERUSER and bypasses RLS; write-api + saga-worker
-- connect as `flashbite_app` (non-superuser) so the policies below actually bind.
-- Password is local-dev-only, mirroring infra/docker-compose.yml; never a real secret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flashbite_app') THEN
    CREATE ROLE flashbite_app LOGIN PASSWORD 'flashbite_app_local_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO flashbite_app;
GRANT SELECT, INSERT, UPDATE ON event_store TO flashbite_app;
GRANT SELECT, INSERT, UPDATE ON outbox TO flashbite_app;

-- Enable + force RLS. FORCE also binds the table owner (harmless here since the owner
-- is the superuser `flashbite`, which bypasses RLS regardless; kept for defense-in-depth
-- if ownership ever changes to a non-superuser).
ALTER TABLE event_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_store FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;

-- Tenant-scoped policy: a row is visible/writable only when its tenant_id matches the
-- per-transaction GUC app.tenant_id. Unset GUC -> current_setting(...,true) = NULL ->
-- comparison is NULL -> fail-closed (no rows, blocked insert).
CREATE POLICY tenant_isolation ON event_store
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON outbox
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
```

- [ ] **Step 2: Apply it**

Run: `pnpm db:deploy`
Expected: the migration applies cleanly ("1 migration applied" / "following migration(s) have been applied"). If it reports already-applied or drift, run `pnpm db:status` and resolve (the folder name must sort after `20260615141341_add_users`).

- [ ] **Step 3: Sanity-check the role + policies exist**

Run (psql via the running container; confirm role + RLS are present):
```bash
docker exec $(docker compose -f infra/docker-compose.yml ps -q postgres) \
  psql -U flashbite -d flashbite_write -c "\dp event_store" -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('flashbite','flashbite_app');"
```
Expected: `flashbite_app` exists with `rolsuper=f`, `rolbypassrls=f`; `event_store`/`outbox` show the `tenant_isolation` policy.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/prisma/migrations/20260616000000_rls_event_store_outbox/migration.sql
git commit -m "feat(db): RLS migration — flashbite_app role + tenant_isolation policies on event_store/outbox"
```

---

## Task 4: write-api writes under RLS (`set_config` + restricted role)

**Files:** `apps/write-api/src/orders/orders.module.ts`, `apps/write-api/src/orders/orders.service.ts`

**Context:** write-api must (a) connect as `flashbite_app` and (b) set `app.tenant_id` at the start of the write transaction so the policy admits the insert. `set_config('app.tenant_id', $1, true)` is parameter-safe (no string interpolation of the tenant). `true` = transaction-local (`SET LOCAL` semantics), so it auto-resets at commit/rollback and never leaks across pooled connections.

- [ ] **Step 1: Provide PrismaService with the app URL**

Edit `apps/write-api/src/orders/orders.module.ts` — replace the bare `PrismaService` provider with a factory that injects `appDatabaseUrl`:

```ts
import { Module } from "@nestjs/common";
import { PrismaService, loadConfig } from "@flashbite/shared";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { AcceptController } from "./accept.controller";
import { TemporalService } from "../temporal/temporal.service";

@Module({
  controllers: [OrdersController, AcceptController],
  providers: [
    OrdersService,
    { provide: PrismaService, useFactory: () => new PrismaService(loadConfig().appDatabaseUrl) },
    TemporalService,
  ],
})
export class OrdersModule {}
```

- [ ] **Step 2: Set the tenant GUC inside the write transaction**

Edit `apps/write-api/src/orders/orders.service.ts` — inside `this.prisma.$transaction(async (tx) => { ... })`, make the FIRST statement set the GUC (before the two `create` calls):

```ts
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.eventStore.create({ /* unchanged */ });
        await tx.outbox.create({ /* unchanged */ });
      });
```

(Keep the existing `eventStore.create` / `outbox.create` bodies and the P2002 idempotency catch exactly as they are.)

- [ ] **Step 3: Ensure APP_DATABASE_URL is available for the e2e**

The write-api e2e boot `AppModule` → `OrdersModule` → the factory reads `appDatabaseUrl`. For RLS to be exercised, `.env` must define `APP_DATABASE_URL` pointing at `flashbite_app`. Add it in Task 8 (`.env.example`) and ensure your local `.env` has it before running e2e. (Do NOT print `.env`; just confirm the var name is `APP_DATABASE_URL`.) The role is created by Task 3's migration; run `pnpm db:deploy` first.

- [ ] **Step 4: Run write-api e2e under RLS**

Run: `pnpm infra:up && pnpm db:deploy && pnpm exec jest apps/write-api`
Expected: PASS — placing an order (berlin token → `set_config('berlin')` → insert passes WITH CHECK), idempotency, 400/401/403, and the tenant-from-token test (tokyo token → `set_config('tokyo')` → tokyo row written). If a write fails with a row-level-security violation, confirm `set_config` runs first in the transaction and that `APP_DATABASE_URL` points at `flashbite_app`.

- [ ] **Step 5: Commit**

```bash
git add apps/write-api/src/orders/orders.module.ts apps/write-api/src/orders/orders.service.ts
git commit -m "feat(write-api): connect as flashbite_app + set app.tenant_id per write tx (RLS)"
```

---

## Task 5: saga-worker writes under RLS

**Files:** `packages/shared/src/event-store.ts`, `apps/saga-worker/src/main.ts`

**Context:** The saga worker appends `OrderAccepted`/`OrderCancelled` via `appendEvent`. It must connect as `flashbite_app` and set `app.tenant_id` (from the envelope's tenant) inside `appendEvent`'s transaction.

- [ ] **Step 1: set_config in appendEvent**

Edit `packages/shared/src/event-store.ts` — inside `prisma.$transaction(async (tx: Tx) => { ... })`, make the FIRST statement:

```ts
  return prisma.$transaction(async (tx: Tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${args.tenantId}, true)`;
    const last = await tx.eventStore.findFirst({ /* unchanged */ });
    // ... rest unchanged (version calc, buildEnvelope, eventStore.create, outbox.create)
  });
```

(The `findFirst` version lookup now also runs under the policy — correct, since it should only see this tenant's prior versions.)

- [ ] **Step 2: saga-worker connects as flashbite_app**

Edit `apps/saga-worker/src/main.ts` — change `const prisma = new PrismaClient();` to use the app URL:

```ts
  const config = loadConfig();
  const prisma = new PrismaClient({ datasources: { db: { url: config.appDatabaseUrl } } });
  await prisma.$connect();
```

(`loadConfig` is already imported in that file; if not, add `import { loadConfig } from "@flashbite/shared";` — verify the existing import line.)

- [ ] **Step 3: Update the event-store unit test for the GUC**

`packages/shared/src/event-store.spec.ts` constructs `new PrismaClient()` (superuser, bypasses RLS) and calls `appendEvent`. Because the superuser bypasses RLS, `set_config` is harmless and the existing assertions still hold. Run it to confirm no regression:

Run: `pnpm exec jest packages/shared/src/event-store.spec.ts`
Expected: PASS (unchanged behavior; `set_config` is a no-op effect for the superuser path).

- [ ] **Step 4: Run saga e2e**

Run: `pnpm infra:up && pnpm db:deploy && pnpm exec jest apps/saga-worker`
Expected: PASS. The saga e2e start the real worker (now `flashbite_app`); `appendEvent` sets the GUC so accepted/cancelled events are written under RLS. If the worker cannot write, confirm `appDatabaseUrl` resolves to `flashbite_app` and the migration is applied.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/event-store.ts apps/saga-worker/src/main.ts
git commit -m "feat(saga-worker): connect as flashbite_app + set app.tenant_id in appendEvent (RLS)"
```

---

## Task 6: outbox-poller stays privileged (verify, no code change)

**Files:** none (verification only — `apps/outbox-poller` must keep `DATABASE_URL`).

**Context:** The poller reads PENDING outbox rows across ALL tenants and marks them SENT. As the superuser `flashbite` (via `DATABASE_URL`), it bypasses RLS and sees every tenant — exactly what we want. Confirm it is NOT switched to `appDatabaseUrl`.

- [ ] **Step 1: Confirm the poller still uses the default (superuser) connection**

Inspect `apps/outbox-poller/src/main.ts`: it must still be `new PrismaService()` (no URL arg) and `apps/outbox-poller/src/poller.ts` `findMany({ where: { status: "PENDING" } })` with no tenant filter. No change required.

- [ ] **Step 2: Run the poller test**

Run: `pnpm exec jest apps/outbox-poller`
Expected: PASS. (The poller, as superuser, reads/relays rows from all tenants regardless of RLS.)

- [ ] **Step 3: No commit** (nothing changed). If you discover the poller was accidentally pointed at `appDatabaseUrl`, revert that and note it.

---

## Task 7: RLS isolation integration test

**Files:** `packages/shared/test/rls.e2e-spec.ts`

**Context:** Prove enforcement directly: connect as `flashbite_app` and assert that (a) with `app.tenant_id='berlin'`, inserting a `tokyo` row is rejected by `WITH CHECK`; (b) a `berlin`-scoped SELECT cannot see `tokyo` rows; (c) without any `app.tenant_id`, reads return nothing and writes are blocked (fail-closed); (d) the superuser connection sees all tenants. Uses raw SQL via a `flashbite_app` PrismaClient + a superuser PrismaClient. Requires `APP_DATABASE_URL` (flashbite_app) and `DATABASE_URL` (superuser) in `.env`, and the migration applied.

- [ ] **Step 1: Write the test**

Create `packages/shared/test/rls.e2e-spec.ts`:

```ts
import "reflect-metadata";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { loadConfig } from "@flashbite/shared";

// flashbite_app (restricted) vs superuser. set_config(..., true) is transaction-local,
// so each isolation assertion runs inside its own interactive transaction.
describe("RLS tenant isolation (event_store/outbox)", () => {
  const cfg = loadConfig();
  const app = new PrismaClient({ datasources: { db: { url: cfg.appDatabaseUrl } } });
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
    ).rejects.toThrow(); // row-level security WITH CHECK violation
  });

  it("allows inserting a row whose tenant_id == app.tenant_id", async () => {
    const row = seedRow("berlin");
    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', 'berlin', true)`;
      await tx.eventStore.create({ data: row as never });
    });
    // visible to the superuser (bypasses RLS)
    const found = await owner.eventStore.findUnique({ where: { id: row.id } });
    expect(found?.tenantId).toBe("berlin");
  });

  it("hides other tenants' rows from a scoped SELECT (USING)", async () => {
    // seed a tokyo row as superuser (bypasses RLS)
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
    // a fresh transaction without set_config; current_setting('app.tenant_id', true) is NULL
    const rows = await app.eventStore.findMany({ take: 5 });
    expect(rows).toHaveLength(0);
  });

  it("the superuser connection sees rows across tenants", async () => {
    const all = await owner.eventStore.findMany({ take: 5 });
    expect(all.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm infra:up && pnpm db:deploy && pnpm exec jest packages/shared/test/rls.e2e-spec.ts`
Expected: PASS (5 tests). If the "fail-closed" test sees rows, the role has unexpected privileges (check `rolbypassrls=f`); if the WITH CHECK test does not throw, confirm the policy + role are applied and `APP_DATABASE_URL` truly points at `flashbite_app` (not the superuser).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/test/rls.e2e-spec.ts
git commit -m "test(db): RLS isolation e2e — cross-tenant insert/select blocked for flashbite_app"
```

---

## Task 8: Env docs + README + full verification

**Files:** `.env.example`, `README.md`

- [ ] **Step 1: Document APP_DATABASE_URL**

In `.env.example`, add (near the existing `DATABASE_URL` line) a documented entry — dev-only credentials matching the migration's role password:

```
# Restricted role used by write-api + saga-worker so Postgres RLS enforces tenant isolation
# (the default DATABASE_URL role is a superuser and bypasses RLS). Created by the
# 20260616000000_rls_event_store_outbox migration. Local-dev password only.
APP_DATABASE_URL="postgresql://flashbite_app:flashbite_app_local_dev@localhost:5434/flashbite_write?schema=public"
```

(Match the host:port + dbname used by the existing `DATABASE_URL` example — confirm the port from the existing `DATABASE_URL` line in `.env.example`; the compose maps `5434:5432` in this environment. Do NOT read `.env`; edit `.env.example` only.)

- [ ] **Step 2: README note**

In `README.md`, in the "Run the full app" section (right after `pnpm db:deploy`), add a line noting the restricted role:

```
> Phase 2 RLS: `pnpm db:deploy` also creates the restricted `flashbite_app` Postgres role.
> write-api + saga-worker connect as it via `APP_DATABASE_URL` so Row-Level Security enforces
> tenant isolation on `event_store`/`outbox`; the outbox-poller stays on the superuser
> `DATABASE_URL` (it relays every tenant's events).
```

- [ ] **Step 3: Full verification**

Run: `pnpm infra:up && pnpm db:deploy && pnpm test`
Expected: PASS across the whole backend suite — including the new RLS isolation test, write-api e2e (writing under RLS), saga e2e, poller, identity, tenant-context, shared. If any non-RLS test regressed, investigate; do not weaken assertions. Report the totals.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs(db): document APP_DATABASE_URL + RLS role in .env.example and README"
```

---

## Self-review notes (coverage check)

- **Restricted role + RLS policies on event_store/outbox** → Task 3.
- **write-api writes as flashbite_app + set app.tenant_id** → Tasks 2, 4.
- **saga-worker writes as flashbite_app + set app.tenant_id** → Tasks 2, 5.
- **poller/migrations/identity stay superuser (read all tenants)** → Task 6 (verify) + Task 3 (migrations run as superuser).
- **APP_DATABASE_URL config + env** → Tasks 1, 8.
- **Isolation proven (insert blocked, select hidden, fail-closed, superuser sees all)** → Task 7.
- **Out of scope:** no RLS on `users`/`processed_events`; no auth/operator/frontend changes.

## Notes for the executor

- Run `pnpm infra:up && pnpm db:deploy` before any e2e (the migration creates `flashbite_app`; tests need it + `APP_DATABASE_URL` in `.env`).
- `set_config('app.tenant_id', <value>, true)` is transaction-local and parameter-safe — never string-interpolate the tenant into SQL.
- The superuser bypass is intentional and load-bearing: it's why the poller (and migrations/identity) keep working unchanged. Do not give `flashbite_app` BYPASSRLS.
- If `pnpm db:deploy` complains about the manually-created migration folder, alternatively generate it with `--create-only` then paste the SQL; the goal is the SQL applied + tracked.
