# FlashBite Phase 1d-iii — Driver View (Design Spec)

**Date:** 2026-06-14
**Status:** Approved (pending spec review)
**Slice:** Third of four Phase 1d frontend slices. Builds on `packages/web-shared` (1d-i + 1d-ii).

## Goal

A driver-facing app: the driver goes "online" and streams their GPS location (simulated
random-walk) into the telemetry plane, and sees nearby drivers on a self-centered canvas +
list. This is the **driver telemetry surface** — the live view of the `1c-ii` geo plane.

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
| **1d-iii (this)** | Driver view — GPS emitter + nearby | this spec |
| 1d-iv | Admin grid (cross-tenant GMV + telemetry canvas) | later |

## Scope

**In:** a new `apps/web-driver` app; `reportLocation` + `getNearbyDrivers` API client fns +
a per-tenant city-center seed + a pure `randomWalk` helper in `web-shared`; a driver page with
a driver/tenant picker, an online toggle, a simulated GPS emitter, a self-centered SVG canvas,
and a nearby-drivers list.

**Out (later / other slices / backlog):** order↔driver dispatch + accept/deliver (backlog
"Driver dispatch" backend phase); real device geolocation (simulated only); the cross-tenant
admin telemetry canvas (1d-iv); auth/JWT (Phase 2).

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
  script `dev:web-driver`.
- **`packages/web-shared` additions:**
  - API client: `reportLocation(tenant, driverId, { lng, lat, orderId? })` → `POST
    /api/read/drivers/:driverId/location`; `getNearbyDrivers(tenant, lng, lat, radiusKm?)` →
    `GET /api/read/drivers/nearby` → `NearbyDriver[]`. Both attach `X-Tenant-ID`. Export a
    `NearbyDriver` type (or reuse the read-api shape).
  - `src/geo/city-centers.ts`: `CITY_CENTERS: Record<Tenant, { lng; lat }>` — Berlin
    `{13.405, 52.52}`, Tokyo `{139.70, 35.68}`.
  - `src/geo/random-walk.ts`: pure `randomWalk(from, stepDeg)` → next `{lng,lat}` nudged by a
    bounded random delta (mirrors `scripts/stream-gps.sh`); deterministic-testable shape.

## Components & screens (`apps/web-driver`)

- **`/` (driver page)** — header (brand + driver-id picker + tenant), an **online toggle**,
  and (when online) the **NearbyCanvas** + **NearbyList**.
- **`useGpsEmitter(tenant, driverId, online)`** — while `online`, every ~2s advances the
  position via `randomWalk` (seeded at the tenant city center on start) and calls
  `reportLocation`; returns the current position. Stops cleanly on toggle-off/unmount (active
  flag + clearTimeout); survives a transient `reportLocation` failure (keeps looping).
- **`NearbyCanvas`** — an SVG that projects the driver (centered, green) + nearby drivers
  (dots) into a fixed viewBox scaled to the radius, with a dashed radius ring. No maps library.
- **`NearbyList`** — a lightweight list of `driverId` + `distanceKm` rows (already
  distance-sorted by the backend); the driver's own id is filtered out. (Not the `DataTable`
  — a short, pre-sorted, frequently-refreshing readout doesn't need sort/filter/paginate.)
- Driver id: a small set of demo ids (e.g. `drv-1`..`drv-4`) selectable, default `drv-1`;
  tenant via a switcher (berlin/tokyo), default berlin.

## Data flow

- Toggle **Go online** → `useGpsEmitter` seeds position at `CITY_CENTERS[tenant]`, then each
  tick: `randomWalk` the position → `reportLocation(tenant, driverId, pos)` (202). After each
  tick (or on a ~2s cadence) → `getNearbyDrivers(tenant, pos.lng, pos.lat, 5)` → update the
  canvas + list (filtering out `driverId`).
- Toggle **Go offline** → stop the loop; canvas/list clear (driver stops appearing in others'
  nearby queries once their geo entry ages out — ephemeral).
- All calls carry `X-Tenant-ID`; switching tenant re-seeds the position and re-scopes queries.

## Error handling

- `reportLocation` failure → keep the loop running (transient), show a small "reconnecting…"
  hint; never crash the page.
- `getNearbyDrivers` failure → keep last results, soft error; explicit empty state when no
  nearby drivers.
- Offline by default — nothing emits until the user goes online. Invalid coords are impossible
  (random-walk stays within valid lng/lat bounds).

## Testing

- **Vitest (`web-shared`)**: `reportLocation`/`getNearbyDrivers` request shape + `X-Tenant-ID`
  + proxy paths; `randomWalk` (output within `±step`, stays in valid bounds); `CITY_CENTERS`
  per-tenant; the self-filter (caller's `driverId` excluded from the nearby list).
- **Playwright e2e (`apps/web-driver`)**: go online → assert the status shows "streaming" and
  at least one `POST …/drivers/:id/location` returns 202 (or a ping counter increments), and a
  nearby refresh occurs. Tenant-scoped. (Needs read-api + telemetry-worker + infra running.)

## Open assumptions

- Tenant via `X-Tenant-ID` (no auth until Phase 2); driver id chosen from a small demo set.
- GPS is simulated random-walk (no real geolocation); ~2s cadence and 5km radius are defaults.
- Nearby is a lightweight list + SVG canvas (not the `DataTable`).
- No order integration — see the backlog "Driver dispatch" phase for the order↔driver loop.
