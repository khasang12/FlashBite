# FlashBite Phase 1d-iv — Admin Grid (Design Spec)

**Date:** 2026-06-15
**Status:** Approved (pending spec review)
**Slice:** Fourth and final Phase 1d frontend slice. Builds on `packages/web-shared` (1d-i/ii/iii, merged).

## Goal

A cross-tenant **operator/admin view**: one screen that aggregates the whole platform — GMV and
order analytics (recharts charts + summary cards), a combined orders table (all statuses,
**cancelled with reason**), and a **side-by-side per-tenant driver telemetry canvas**. It reads
the existing per-tenant APIs and stitches the tenants together in the browser.

## Scope decision (read first): client-side fan-out, plus one focused read-model change

The read-api is **strictly tenant-scoped** — every route resolves `getTenantId()` from the
`X-Tenant-ID` header; there is **no cross-tenant endpoint**, and there is **no auth** in Phase 1.
So the admin grid **fans out client-side**: it loops the fixed `TENANTS` (`berlin`, `tokyo`),
calls the existing per-tenant endpoints once per tenant, and aggregates in the browser (chosen
option **A**). A dedicated authenticated `/admin/*` cross-tenant API is the right long-term shape
but is a **backend phase requiring Phase-2 JWT auth** — deferred to the backlog ("Admin API —
authenticated cross-tenant read model"). An unauthenticated route that bypasses tenant isolation
would be a security regression in Phase 1.

**One focused backend change is in scope:** the cancellation **reason** is currently not exposed
on the read side (`OrderView` has no reason; the projection sets only `status = CANCELLED`; the
SSE event omits it). To show "cancelled with reason", we add `cancelReason` to the read model —
see Backend changes below. This adds **no cross-tenant endpoint**; the fan-out (option A) is
unchanged.

## Phase 1d slice context

| Slice | Surface | Status |
|------|---------|--------|
| 1d-i | Customer storefront + shared foundation | done (merged) |
| 1d-ii | Merchant dashboard | done (merged) |
| 1d-iii | Driver view (nearby viewer) | done (merged) |
| **1d-iv (this)** | Admin grid — cross-tenant GMV/analytics + telemetry canvas | this spec |

## Scope

**In:** a new `apps/web-admin` app (:3103); pure cross-tenant **aggregation helpers** in
`web-shared`; a backend `cancelReason` addition to the order read model; an admin page with
summary cards, **recharts** charts (GMV-by-tenant, status breakdown, top SKUs, GMV-over-time), a
**side-by-side per-tenant driver map** canvas, and a combined orders `DataTable` (tenant + status
+ reason). Live order updates via **SSE fan-out** (one `useOrderStream` per tenant); driver
positions via per-tenant polling.

**Out (later / other slices / backlog):** a cross-tenant `/admin/*` backend API + auth (backlog
"Admin API"); full-history analytics / pagination (backlog "telemetry-archiver" + an orders
history store); real device geolocation; any write actions (admin is read-only).

## Backend this builds on (read-api :3002, all tenant-scoped via `X-Tenant-ID`)

- **Orders list:** `GET /merchant/orders` → `OrderView[]` for the tenant (latest, capped at 100).
- **Order stream (SSE):** `GET /merchant/orders/stream` → per-tenant `OrderStreamEvent`s.
- **Nearby drivers:** `GET /drivers/nearby?lng&lat&radiusKm` → `NearbyDriver[]` for the tenant.
- `web-shared` already wraps these: `listOrders`, `useOrderStream`, `getNearbyDrivers`,
  `TENANTS`, `CITY_CENTERS`, `DataTable`, `Select`, `Card`, `StatusPill`, `cn`.

## Backend changes (the focused read-model `cancelReason`)

- **contracts:** add `cancelReason?: string` to `OrderView`. (The `OrderCancelled` payload already
  carries `reason: string`.)
- **projection-worker:** on `OrderCancelled`, persist `cancelReason = payload.reason` onto the
  order document (alongside `status = CANCELLED`). Other transitions leave it unset.
- **read-api:** the order view returned by `GET /orders/:id` and `GET /merchant/orders` flows the
  field through (it serializes the stored document). No new endpoint.
- **SSE feeder:** include `cancelReason` on the emitted event for `OrderCancelled` so a live
  cancellation shows its reason too. `OrderStreamEvent` gains an optional `cancelReason?: string`.
- Existing merchant dashboard benefits for free (can show the reason later); no behavior change
  required there in this slice.

## Architecture

- **`apps/web-admin`** — Next.js (App Router, TS, Tailwind v4). Dev on **3103**. Reuses
  `@flashbite/web-shared`; same `next.config` rewrites (`/api/read/*`→:3002, `/api/write/*`→:3001
  — only `/api/read` is used), same root-Jest isolation (`testPathIgnorePatterns` for
  `apps/web-admin`), shared theme import + Manrope. Root scripts `dev:web-admin` +
  `test:e2e:admin`. Standalone app (microfrontend shell still deferred — backlog).
- **Charts:** `recharts` (web-admin dep) for the four charts; chart components are client-only.
- **Maps:** per-tenant `react-map-gl`/`mapbox-gl` maps (a `TenantMap` component, markers only,
  same token-gated fallback as 1d-iii via `NEXT_PUBLIC_MAPBOX_TOKEN`).
- **`packages/web-shared` additions** — pure, framework-free aggregation helpers (the single
  frontend unit-test home), operating on a merged `OrderView[]` (each row already has `tenantId`):
  - `aggregateGmv(orders)` → Σ `totalAmount` where `status !== CANCELLED`.
  - `gmvByTenant(orders)` → `{ tenant, gmv }[]`.
  - `statusBreakdown(orders)` → `{ tenant, placed, accepted, cancelled }[]`.
  - `topSkus(orders, limit=5)` → `{ sku, qty }[]` (sum `items[].qty` over non-cancelled orders,
    desc).
  - `gmvOverTime(orders)` → `{ bucket, gmv }[]` (group by hour of `updatedAt`, non-cancelled,
    ascending).
  - `orderCounts(orders)` → `{ total, cancelled, cancelRate }`.
  - `cancelReasonOf(order)` → display string (maps the `OrderCancelled` reason / falls back).

## Components & screens (`apps/web-admin`)

- **`/` (admin page)** — orchestrator: on mount, for each tenant fans out `listOrders(tenant)`
  (snapshot) and opens `useOrderStream(tenant)` (live), merging into one `OrderView[]`; polls
  `getNearbyDrivers(tenant, CITY_CENTERS[tenant], radiusKm)` every ~5s into a per-tenant
  `NearbyDriver[]` map. Renders the sections below from derived data.
- **`StatCards`** — Total GMV (excl. cancelled), Orders (all statuses), Cancelled (count + rate),
  Active drivers (total + per-tenant).
- **`GmvByTenantChart`** (recharts bar), **`StatusBreakdownChart`** (stacked bar per tenant),
  **`TopSkusChart`** (horizontal bar), **`GmvOverTimeChart`** (area, hourly buckets).
- **`TenantMap`** (×2, side by side) — a `react-map-gl` map per tenant centered on
  `CITY_CENTERS[tenant]`, a marker per nearby driver; token-gated fallback. Header shows the
  per-tenant active count.
- **Orders table** — shared `DataTable`: columns Tenant, Order, Customer, Total, Status (+ the
  cancel reason when `CANCELLED`), Updated. `emptyMessage="No orders yet."`.

## Data flow

- **Load:** for each `tenant` in `TENANTS` → `listOrders(tenant)` → concat into `orders`
  (`OrderView[]`, each carries `tenantId`). All cards/charts/table derive from `orders` via the
  web-shared helpers.
- **Live (orders):** `useOrderStream(tenant)` per tenant; on event, upsert/refetch into `orders`
  (reuse `applyOrderEvent`/`upsertOrder`/`getOrder` as the merchant page does), so GMV/charts
  update live. A live `OrderCancelled` carries `cancelReason`.
- **Drivers:** poll `getNearbyDrivers(tenant, CITY_CENTERS[tenant].lng/lat, 5)` per tenant every
  ~5s → `Record<Tenant, NearbyDriver[]>` → the two maps + active counts.
- Switching nothing tenant-wide: the admin always shows **all** tenants at once.

## Metrics definitions (and the data-window caveat)

- **GMV** = sum of `totalAmount` over orders whose `status !== CANCELLED` (cancelled orders are
  shown in the table/breakdown but never counted toward GMV).
- **Cancel rate** = cancelled / total (all fetched orders).
- **Top SKUs / GMV-over-time** are computed from the **fetched orders only** — `GET
  /merchant/orders` returns the **latest ≤100 per tenant** (capped, no pagination), and
  `updatedAt` is the last status-change time, not order-placed time. So these reflect a **recent
  window**, not full history. This is acceptable for the showcase; full-history analytics is the
  backlog "telemetry-archiver / orders history store" work.

## Error handling

- A failing tenant fetch (`listOrders`/`getNearbyDrivers`) is isolated: that tenant contributes
  no data, the rest still render; show a small per-section "couldn't load <tenant>" hint; never
  crash the page.
- `getNearbyDrivers` poll failure → keep last positions, soft error.
- Missing `NEXT_PUBLIC_MAPBOX_TOKEN` → each `TenantMap` shows the fallback panel; cards, charts,
  and table still work.
- Empty states: zero orders → charts/table show explicit empty messages; zero drivers → map
  empty + "0 drivers".

## Testing

- **Vitest (`web-shared`)** — the aggregation helpers: `aggregateGmv` (excludes cancelled),
  `gmvByTenant`, `statusBreakdown`, `topSkus` (sum/sort/limit), `gmvOverTime` (hourly bucketing,
  ascending, excludes cancelled), `orderCounts` (rate), `cancelReasonOf`.
- **Jest (backend)** — projection persists `cancelReason` on `OrderCancelled` (unit/e2e);
  contracts spec for the `OrderView`/`OrderStreamEvent` field; read-api passes it through
  (e2e against Mongo); SSE feeder includes it on cancel.
- **Playwright e2e (`apps/web-admin`)** — page loads; fans out across tenants (assert two
  `GET …/merchant/orders` and two `GET …/drivers/nearby`); the stat cards, at least one chart,
  the two tenant map regions, and the combined orders table render. Map tiles not asserted
  (WebGL/token). (Needs read-api + infra; seed orders incl. a cancelled one with a reason.)

## Open assumptions

- Tenant set is the fixed `TENANTS` (`berlin`, `tokyo`); fan-out iterates it. No auth (Phase 2).
- Admin is **read-only** (no write/admin actions).
- Live orders via **SSE fan-out** (one connection per tenant, 2 total); drivers via ~5s polling
  (no driver SSE exists).
- Charts via **recharts**; maps via `react-map-gl` with the same token-gated fallback as 1d-iii.
- Analytics reflect the **recent ≤100-orders/tenant window** (see caveat) — full history is
  backlog.
- Cross-tenant `/admin/*` API + auth is deferred to the backlog "Admin API".
