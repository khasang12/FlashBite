# FlashBite Phase 1d-iii — Driver View (Design Spec)

**Date:** 2026-06-14
**Status:** Implemented (revised 2026-06-15: read-only viewer — GPS streamed externally)
**Slice:** Third of four Phase 1d frontend slices. Builds on `packages/web-shared` (1d-i + 1d-ii).

> **Revision 2026-06-15:** The driver app no longer **emits** its own GPS. GPS pings are
> streamed externally by `scripts/stream-gps.sh` (the script POSTs to the same ingest endpoint).
> The app is now a **read-only nearby viewer**: it polls `getNearbyDrivers` around the tenant
> city center and highlights the selected driver as "you" when its ping appears in the geo index.
> Consequently `randomWalk` and the in-app emitter were removed; `reportLocation` is kept in
> `web-shared` (it documents the ingest endpoint the script hits) but is no longer called by the app.

## Goal

A driver-facing app: the driver picks a tenant + driver id, starts **watching**, and sees
nearby drivers on a Mapbox map + a `DataTable` — the selected driver shown as "you" when it is
streaming. GPS pings are produced externally (`scripts/stream-gps.sh`). This is the **driver
telemetry surface** — the live read view of the `1c-ii` geo plane.

## Scope decision (read first): telemetry-only, NOT order-integrated

The driver view is **not wired into the order lifecycle** — by design, for this slice. The
order plane (saga: charge → merchant accept/decline → accept/refund) and the telemetry plane
(driver GPS → Redis geo → nearby) are currently disconnected: no backend assigns an accepted
order to a driver, and nothing consumes a driver↔order link (`DriverLocationDto.orderId`
exists but is carried-and-unused downstream). Closing that loop ("driver dispatch") is a
**separate backend phase**, captured in `docs/superpowers/backlog.md` ("Driver dispatch —
close the order↔driver loop"). This slice ships the standalone telemetry/GPS surface (the
chosen option A); it deliberately does NOT fake an order integration.

## Phase 1d slice context

| Slice | Surface | Status |
|------|---------|--------|
| 1d-i | Customer storefront + shared foundation | done (merged) |
| 1d-ii | Merchant dashboard | done (merged) |
| **1d-iii (this)** | Driver view — nearby viewer (GPS streamed via script) | this spec |
| 1d-iv | Admin grid (cross-tenant GMV + telemetry canvas) | later |

## Scope

**In:** a new `apps/web-driver` app; `getNearbyDrivers` + `reportLocation` API client fns + a
per-tenant city-center anchor + a `toNearbyRows`/`formatKm` helper in `web-shared`; a driver page
with a driver/tenant picker, a **Start/Stop watching** toggle, a `getNearbyDrivers` poller, a
**Mapbox map** (self + nearby markers), and a **nearby-drivers `DataTable`**.

**Out (later / other slices / backlog):** in-app GPS emission (GPS is streamed by
`scripts/stream-gps.sh`); order↔driver dispatch + accept/deliver (backlog "Driver dispatch"
backend phase); real device geolocation; the cross-tenant admin telemetry canvas (1d-iv);
auth/JWT (Phase 2).

## Backend this builds on (verified, telemetry plane = read-api :3002)

- **Location ingest:** `POST /drivers/:driverId/location` (tenant via `X-Tenant-ID`), body
  `{ lng:number[-180,180], lat:number[-90,90], orderId?:string }`, → 202 `{ driverId }`.
  Publishes `DriverTelemetryStreamed` to `telemetry-streams` → telemetry-worker `GEOADD`s into
  the per-tenant Redis geo key.
- **Nearby query:** `GET /drivers/nearby?lng&lat&radiusKm` (default radiusKm 5; tenant via
  `X-Tenant-ID`) → `NearbyDriver[]` = `{ driverId, distanceKm, lng, lat }`, distance-sorted
  ascending (Redis `GEOSEARCH` on the tenant geo key). May include the caller's own driver.

## Architecture

- **`apps/web-driver`** — Next.js (App Router, TypeScript, Tailwind v4). Dev on **3102**.
  Reuses `@flashbite/web-shared`. Same `next.config` rewrites (`/api/read/*`→:3002,
  `/api/write/*`→:3001 — only `/api/read` is needed here), same root-Jest isolation
  (`testPathIgnorePatterns` for `apps/web-driver`), same shared theme import + Manrope. Root
  script `dev:web-driver`. (Standalone app for now; a microfrontend composition — Next.js
  Multi-Zones or Module Federation across web-customer/web-merchant/web-driver — is deferred to
  the backlog, to land when the ordering flow is unified. See backlog "Microfrontend shell".)
- **Mapbox:** `react-map-gl` (v8, React 19 compatible) over `mapbox-gl` (v3) for the live map.
  Public token via `NEXT_PUBLIC_MAPBOX_TOKEN` (a publishable token — never commit it; read from
  env, document in `.env.example`). `mapbox-gl/dist/mapbox-gl.css` imported in the app. If the
  token is absent, `NearbyMap` renders a graceful fallback panel ("set NEXT_PUBLIC_MAPBOX_TOKEN")
  instead of crashing — the watcher + table still work.
- **`packages/web-shared` additions:**
  - API client: `getNearbyDrivers(tenant, lng, lat, radiusKm?)` → `GET /api/read/drivers/nearby`
    → `NearbyDriver[]`; `reportLocation(tenant, driverId, { lng, lat, orderId? })` → `POST
    /api/read/drivers/:driverId/location` (kept for the documented ingest contract; not called by
    the app — `scripts/stream-gps.sh` is the producer). Both attach `X-Tenant-ID`. Export a
    `NearbyDriver` type.
  - `src/geo/types.ts`: `GeoPoint = { lng; lat }`.
  - `src/geo/city-centers.ts`: `CITY_CENTERS: Record<Tenant, GeoPoint>` — Berlin
    `{13.405, 52.52}`, Tokyo `{139.70, 35.68}` — the per-tenant map/query anchor.
  - `src/geo/nearby.ts`: `toNearbyRows(nearby, selfDriverId)` (drops the caller) + `formatKm`.

## Components & screens (`apps/web-driver`)

- **`/` (driver page)** — header (brand + driver-id picker + tenant), a **Start/Stop watching**
  toggle, and (when watching) the **NearbyMap** + **NearbyTable**. Derives `self` = the selected
  driver found within the nearby results, `others` = `toNearbyRows(nearby, driverId)`, and the
  map anchor = `self` position when present, else `CITY_CENTERS[tenant]`.
- **`useNearbyWatch(tenant, watching)`** — while `watching`, every ~2s polls
  `getNearbyDrivers(tenant, CITY_CENTERS[tenant].lng/lat, 5)` and returns `{ nearby, reconnecting }`.
  Stops cleanly on toggle-off/unmount (active flag + clearTimeout); a transient query failure
  keeps the last results and flags `reconnecting`.
- **`NearbyMap`** — a `react-map-gl` Mapbox map: props `{ center, self, nearby }`; always renders
  (centered on `center`, recentering via `easeTo`), a green **you** marker only when `self` is
  present, a dark marker per nearby driver. Token-gated graceful fallback (see Architecture).
  Presentational only (no data fetching). Excluded from unit tests (WebGL can't render in jsdom);
  covered by e2e + manual.
- **`NearbyTable`** — the shared `DataTable` with columns `driverId` and `distanceKm` (km, 2dp),
  default-sorted ascending by distance, `emptyMessage="No nearby drivers."`. Receives `others`.
- Driver id: a small set of demo ids (`drv-1`..`drv-4`) selectable, default `drv-1`; tenant via a
  switcher (berlin/tokyo), default berlin.

## Data flow

- **Out of band:** `scripts/stream-gps.sh` POSTs driver pings to read-api → `telemetry-streams`
  → telemetry-worker `GEOADD`s them into the per-tenant Redis geo key. The app does not produce
  these.
- Toggle **Start watching** → `useNearbyWatch` polls `getNearbyDrivers(tenant,
  CITY_CENTERS[tenant], 5)` every ~2s → page derives `self`/`others` → update the map + table.
- Toggle **Stop watching** → stop the loop; the map/table section is hidden.
- All calls carry `X-Tenant-ID`; switching tenant re-anchors and re-scopes the query.

## Error handling

- `getNearbyDrivers` failure → keep last results, flag `reconnecting`; explicit empty state when
  no nearby drivers; never crash the page.
- Missing `NEXT_PUBLIC_MAPBOX_TOKEN` → `NearbyMap` shows a fallback panel; the watcher and the
  `NearbyTable` continue to work (the map is enhancement, not a hard dependency).
- Not watching by default — nothing polls until the user starts. The selected driver appears as
  "you" only once its ping is in the geo index (else a "not streaming yet" hint).

## Testing

- **Vitest (`web-shared`)** — the single frontend unit-test home (apps carry no unit tests, per
  the web-customer/web-merchant pattern): `reportLocation`/`getNearbyDrivers` request shape +
  `X-Tenant-ID` + proxy paths; `CITY_CENTERS` per-tenant; `toNearbyRows` (caller's `driverId`
  excluded) + `formatKm`.
- **Playwright e2e (`apps/web-driver`)** — covers the components (NearbyTable, NearbyMap,
  useNearbyWatch wiring): default shows "Not watching"; Start watching → assert a
  `GET …/drivers/nearby` returns 200 and the nearby section appears (table populates). Tenant-
  scoped. Map tiles are not asserted (WebGL/token dependent). (Needs read-api + infra running.)

## Open assumptions

- Tenant via `X-Tenant-ID` (no auth until Phase 2); driver id chosen from a small demo set.
- GPS is streamed externally by `scripts/stream-gps.sh` (no in-app emission, no real device
  geolocation); the app polls nearby at a ~2s cadence with a 5km radius (defaults).
- Nearby is rendered as the shared `DataTable` + a Mapbox map (`react-map-gl`); map needs a
  public `NEXT_PUBLIC_MAPBOX_TOKEN`, with a graceful fallback when absent.
- App is standalone on :3102; a microfrontend shell is deferred (backlog "Microfrontend shell").
- No order integration — see the backlog "Driver dispatch" phase for the order↔driver loop.
