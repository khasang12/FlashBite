# FlashBite Phase 2 (S1–S4) — Verified-JWT Tenancy + RLS + Operator Console + FE Auth (Design Spec)

**Date:** 2026-06-15
**Status:** Approved (pending spec review)
**Phase:** Completes Phase 2 (identity + multi-tenant isolation "hard mode"). Builds on 2a (identity service issuing RS256 JWTs + JWKS, already merged).

## Goal

Replace the **trusted `X-Tenant-ID` header** with **cryptographic identity**: a verified RS256
JWT (issued by the 2a identity service) becomes the *only* source of `tenantId` + `role` on the
API tier, and Postgres Row-Level Security makes cross-tenant writes impossible even if app code has
a bug. Migrate all four frontends to obtain and send Bearer tokens, and add an authenticated
cross-tenant operator console API so the admin dashboard stops faking tenancy via the header.

This is a **hard cut**: after S1, write-api and read-api reject any request without a valid Bearer
token. The `X-Tenant-ID` header is removed from the request path (no fallback).

## Slice map (four sequenced PRs)

| Slice | Deliverable | Depends on |
|------|-------------|-----------|
| **S1 — Auth core** | Shared JWT verification (jose) → `tenantId`+`role`+`sub` in AsyncLocalStorage; replace `TenantMiddleware` on write-api + read-api; Bearer-required; `@Roles` guards on mutations; migrate `requests.http` + backend e2e | 2a |
| **S2 — RLS** | Restricted Postgres role + per-tx session var + `ENABLE/FORCE ROW LEVEL SECURITY` on `event_store` + `outbox`; poller & migrations privileged; saga sets the var; isolation test | S1 |
| **S3 — Operator console API** | New `operator` role + seed; `GET /admin/orders`, `/admin/drivers`, `/admin/orders/stream` (cross-tenant, operator-guarded, outside tenant scoping) in read-api | S1 |
| **S4 — Frontend auth** | Minimal dev login in all 4 apps; API client / SSE / Next rewrites send `Authorization: Bearer`; admin uses operator login + `/admin/*`; gps script + Playwright e2e fetch tokens | S1, S3 |

Each slice ships working, testable software and merges as its own PR.

## Architecture (the inversion)

Phase 1 trusted `X-Tenant-ID` → `TenantMiddleware` → `runWithTenant` → `getTenantId()`. Phase 2
makes a verified RS256 JWT the sole source of tenant + role on the API tier, with RLS as
defense-in-depth below it.

```
Browser ──login──> identity:3003 ──RS256 JWT (tenantId, role, sub)──┐
   │                                                                 │
   └─ Authorization: Bearer <jwt> ─> write-api / read-api           │
                                       │ verify sig+iss+aud+exp via JWKS
                                       │ → AsyncLocalStorage{tenantId, role, sub}
                                       ▼
                              write-api ──SET LOCAL app.tenant_id──> Postgres (RLS)
```

**Workers** (saga / projection / telemetry) keep scoping off `envelope.tenantId` — they have no
request or token, and that envelope was authored under a verified identity. The **only worker
touched is saga-worker**, because it *writes* events and so must satisfy RLS (S2).

**read-api never touches Postgres** (it reads Mongo + Redis), so RLS only affects the write plane
(write-api + saga-worker). The operator endpoints (S3) also hit only Mongo + Redis.

## S1 — Auth core

Refactor `@flashbite/tenant-context` into an auth context package (same package, broadened
responsibility):

- **`verifyToken(token)`** — uses `jose.createRemoteJWKSet(JWKS_URL)` + `jwtVerify`, checking
  signature, `iss` (= `JWT_ISSUER`), `aud` (= `JWT_AUDIENCE`), and `exp`. `createRemoteJWKSet`
  fetches + caches JWKS and auto-refetches on an unknown `kid` (matches 2a's
  startup-regenerated keys). Returns `{ tenantId, role, sub }` from the verified claims.
- **`AuthMiddleware`** replaces `TenantMiddleware`: reads the `Authorization: Bearer <token>`
  header, verifies it, and runs `runWithAuth({ tenantId, role, sub }, () => next())`. Missing or
  invalid token → **401** (`UnauthorizedException`). The `DEFAULT_TENANT_ID` request fallback is
  deleted.
- **Context API** — keep `getTenantId()` (now reads the verified context); add `getRole()` and
  `getAuthContext()`. AsyncLocalStorage now stores `{ tenantId, role, sub }`.
- **`@Roles(...)` guard** — a Nest guard reading required roles from metadata and comparing to
  `getRole()`; **403** on mismatch. Applied to mutations:
  - `POST /orders` → `customer`
  - `POST /orders/:id/accept` and `/decline` → `merchant`
  - Reads and telemetry ingest (`POST /drivers/:id/location`) require a valid token but no specific
    role in S1.

Config additions (`loadConfig` / `.env` / `.env.example`): `JWT_JWKS_URL`
(default `http://localhost:3003/.well-known/jwks.json`). `JWT_ISSUER` / `JWT_AUDIENCE` already
exist from 2a and are reused for verification.

`@flashbite/tenant-context` gains a `jose` dependency. `AuthMiddleware` is wired in both
`apps/write-api/src/app.module.ts` and `apps/read-api/src/app.module.ts` (replacing
`TenantMiddleware` on `forRoutes("*")`); `/health` is excluded from `AuthMiddleware`
(`forRoutes("*")` with an `exclude("health")`) so it answers without a token.

`apps/write-api/requests.http` is migrated: every write/read request gains an
`Authorization: Bearer {{login.response.body.$.accessToken}}` header sourced from the existing
`# @name login` request; the `X-Tenant-ID` lines are removed. Backend e2e tests (write-api,
read-api) acquire a token (mint via identity or sign a test JWT with a test key) instead of sending
`X-Tenant-ID`.

## S2 — RLS

A hand-written Prisma migration (`packages/shared/prisma/migrations/<ts>_rls/migration.sql`):

- `CREATE ROLE flashbite_app LOGIN PASSWORD '<from env>'` — **no** `BYPASSRLS`, **no** ownership.
- `GRANT SELECT, INSERT, UPDATE ON event_store, outbox TO flashbite_app` (+ `USAGE` on the schema;
  the tables use UUID `id`s supplied by the app, so no sequence grants needed).
- `ALTER TABLE event_store ENABLE ROW LEVEL SECURITY; ALTER TABLE event_store FORCE ROW LEVEL
  SECURITY;` (and the same for `outbox`) — `FORCE` binds even the table owner, so isolation does
  not silently depend on which role connects.
- Policies on each table: `USING (tenant_id = current_setting('app.tenant_id', true))` and
  `WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`. The `true` (missing_ok) makes
  an unset GUC yield `NULL`, which fails the comparison → zero rows / blocked insert (fail-closed).

Connection strategy:

- New `APP_DATABASE_URL` (connects as `flashbite_app`). **write-api** and **saga-worker** use it.
- `DATABASE_URL` (privileged owner `flashbite`) stays for **migrations**, **outbox-poller** (the
  deliberate cross-tenant reader/updater), and **identity** (user lookups span tenants).
- Every write path issues `SET LOCAL app.tenant_id = '<tenant>'` as the first statement inside its
  `$transaction`:
  - write-api `OrdersService.placeOrder` already uses `$transaction` — inject `SET LOCAL` (via
    `tx.$executeRawUnsafe`) before the inserts; tenant from `getTenantId()`.
  - saga-worker `appendEvent` (in `@flashbite/shared`) wraps its insert in a `$transaction` and
    issues `SET LOCAL app.tenant_id = '<envelope.tenantId>'` first; tenant from the activity's
    envelope.

`PrismaService` is parameterized so an app can choose `APP_DATABASE_URL` vs `DATABASE_URL` (e.g. a
constructor/option reading the chosen env var). `outbox-poller` and `identity` keep the privileged
URL; write-api and saga construct their client with the restricted URL.

Infra: `infra/docker-compose.yml` Postgres seeds nothing extra (the role is created by the
migration). `.env.example` documents `APP_DATABASE_URL` and the `flashbite_app` password
(dev-only). `users` and `processed_events` get **no** RLS — `users` must be cross-tenant-readable
for login; `processed_events` is out of scope for this slice.

## S3 — Operator console API

- **Role + seed.** Add `operator` as a recognized role. Seed one `operator@flashbite.test` with
  `tenantId: "platform"` (a sentinel — the operator's own tenant is irrelevant; `/admin/*` ignores
  it). Update `apps/identity/src/seed.ts`. The per-tenant `admin@*.test` accounts remain (reserved
  for a future tenant-scoped admin view); the cross-tenant console uses `operator`.
- **`OperatorGuard`** (read-api) — admits only `getRole() === "operator"`; **403** otherwise.
- **Routes mounted outside tenant scoping.** The `/admin/*` controller is verified (a valid token
  is required, via `AuthMiddleware`) but does **not** pin a single tenant — it queries across all
  tenants. Endpoints mirror what the admin FE aggregates today, server-side:
  - `GET /admin/orders` — recent orders across all tenants from the Mongo read model (no tenant
    filter), tagged with their `tenantId`.
  - `GET /admin/drivers` — loops the known tenants and `GEOSEARCH`es each tenant's geo index around
    that tenant's city center (mirroring the FE's per-tenant nearby calls), returning all live
    drivers tagged by tenant.
  - `GET /admin/orders/stream` — SSE over `order-events` with **no** tenant filter (its own
    consumer group, distinct from the merchant SSE group), emitting events from every tenant.
- Aggregation (GMV, status breakdown, top SKUs, time series) stays **client-side** in
  `web-shared` for now (the helpers already exist); these endpoints just replace the N-request
  fan-out with single cross-tenant calls. Server-side aggregation remains a backlog item.

## S4 — Frontend auth

- **`useAuth` store** in `web-shared` — a login form (email + password) posts to identity
  `/auth/login`, stores `{ accessToken, tenantId, role }` in memory + `localStorage`, and exposes
  `login`, `logout`, `token`. A minimal guard: if no token, render the login form instead of the
  app. No refresh, no expiry auto-logout (backlog) — an expired token just forces re-login on the
  next 401.
- **API client + SSE.** `packages/web-shared/src/api/client.ts` sends
  `Authorization: Bearer <token>` instead of `X-Tenant-ID`; `use-order-stream.ts` (fetch-based SSE)
  does the same. The Next.js rewrite/proxy routes (e.g.
  `apps/web-merchant/app/api/read/.../route.ts`) forward `Authorization` instead of `X-Tenant-ID`.
- **Per-app login identity.** The old tenant switcher becomes "log in as `role@tenant.test`":
  - web-customer → `customer@<tenant>.test`; web-merchant → `merchant@<tenant>.test`;
    web-driver → `driver@<tenant>.test`.
  - web-admin → logs in as **`operator@flashbite.test`** and calls `/admin/*` (the per-tenant
    fan-out in `use-admin-data.ts` is replaced by the cross-tenant endpoints; the analytics helpers
    still run client-side on the combined result).
- **Dev tooling.** `scripts/stream-gps.sh` performs a `curl` login (driver creds) to obtain a token
  before streaming, sending `Authorization: Bearer`. Playwright e2e (all four apps) acquire a token
  in setup (programmatic login) and drive the UI through its login form.

## Error handling

- Missing / malformed / expired / bad-signature token → **401** (generic `Unauthorized`).
- Valid token, wrong role → **403**.
- JWKS unreachable (identity down) → **401** + a logged server-side error; identity-up is a
  documented prereq in `requests.http`.
- RLS: a mismatched or absent `app.tenant_id` fails the write (insert blocked / zero rows updated),
  surfaced as a 500 and asserted by the isolation test.
- identity restart rotates the `kid`; `createRemoteJWKSet` refetches automatically. Tokens minted
  before the restart fail verification — acceptable, matching 2a's in-memory-key decision.
- The private signing key never leaves identity; verifiers only ever hold public JWKS material.

## Testing

- **S1 (e2e + unit):** valid token → 200 with the token's tenant; no token → 401; wrong role →
  403; tampered/expired token → 401. Unit: `verifyToken` accepts a well-formed token and rejects
  bad `iss` / `aud` / `exp` / signature. Tests mint tokens via a test keypair (or the identity
  service) rather than `X-Tenant-ID`.
- **S2 (integration):** connected as `flashbite_app` with `app.tenant_id='berlin'`, inserting a
  `tokyo` row is rejected (WITH CHECK) and a `berlin` SELECT cannot see `tokyo` rows; the
  privileged poller role sees all tenants. Regression: write-api still places orders end-to-end
  under RLS.
- **S3 (e2e):** an operator token → cross-tenant results from `/admin/orders` and `/admin/drivers`;
  a `merchant`/`customer` token → 403; `/admin/orders/stream` emits events from both tenants.
- **S4 (Playwright + unit):** login → place / track / accept flows pass with Bearer; the admin
  loads via operator login + `/admin/*`. `web-shared` client unit tests assert the `Authorization`
  header (replacing the `X-Tenant-ID` assertions).

Tests run under the existing harnesses: root Jest (backend e2e/integration, infra up), Vitest
(`web-shared` units), Playwright per app.

## Config & dependencies summary

- **New env:** `JWT_JWKS_URL` (verifier), `APP_DATABASE_URL` (restricted role) + the
  `flashbite_app` dev password. Reuse `JWT_ISSUER` / `JWT_AUDIENCE` from 2a.
- **New deps:** `jose` in `@flashbite/tenant-context`.
- **Migrations:** one hand-written SQL migration for the RLS role + policies (S2).
- **Seed:** `operator@flashbite.test` added to the identity seed (S3).

## Open assumptions

- Hard cut: no `X-Tenant-ID` fallback after S1. Frontends are migrated within this phase (S4), so
  there is no long window of broken UIs — but between merging S1 and S4 the frontends require S4 to
  function (the slices land in sequence).
- Two tenants (`berlin`, `tokyo`) + a `platform` sentinel tenant for the operator. Four user roles
  (`customer`, `merchant`, `driver`, `admin`) plus `operator`. No self-signup.
- Access-token-only (~1h); refresh tokens, key persistence/rotation, and revocation remain backlog.
- RLS covers `event_store` + `outbox` only (the write-side aggregate store); `users` and
  `processed_events` are intentionally excluded.
- Operator aggregation stays client-side; a server-side aggregated admin API remains backlog.
