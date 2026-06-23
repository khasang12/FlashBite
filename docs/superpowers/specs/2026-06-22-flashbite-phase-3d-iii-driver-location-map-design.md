# Phase 3d-iii — Customer live driver-location map (design)

**Goal:** On the customer order-tracking page, show the assigned driver's **live position on a map** while the order is out for delivery — without ever exposing the driver's identity.

**Builds on:** the telemetry plane (driver GPS → `telemetry-streams` → telemetry-worker → Redis geo, keyed by driverId), Phase 3d-i (the `DriverDispatch` read model carrying `driverId` on `DISPATCHED`/`PICKED_UP`), Phase 3d-ii (`useGpsEmitter` streams the driver's GPS during an active job), and Phase 3d-iv (the customer page already polls order+dispatch every 2s; the `DeliveryView` privacy filter strips `driverId` from customer reads). Final slice of Phase 3d. Branch `phase-3d-iii-driver-location-map` off `main`.

## Scope

In scope: a read-api endpoint that resolves an order's assigned driver server-side and returns only its current `{lng,lat}`; a web-shared client fn; a customer-app `DriverMap` (single live marker) on the tracking page, polled.

Out of scope: a delivery-destination pin or route (orders carry no destination coordinates — a documented 3d-i simplification); driver identity on the customer side; an SSE location stream (poll, matching the page's existing cadence); merchant/admin live driver maps.

## Constraint

Orders have **no delivery-destination coordinates**. The map therefore shows the **driver's moving dot + a city-center reference** (`CITY_CENTERS[tenant]`) — not a destination pin or route line.

## Architecture & data flow

```
driver app (useGpsEmitter, ~1s) → reportLocation → telemetry-streams → telemetry-worker → Redis geo
                                                                          (tenant:{id}:drivers:geo, keyed by driverId)
customer page (existing 2s poll) → GET /orders/:orderId/driver-location
   → read-api: DispatchQueryService.byOrder(tenant, orderId) → driverId (only when DISPATCHED/PICKED_UP)
              → Redis GEOPOS(driverGeoKey(tenant), driverId) → { location: {lng,lat} | null }   (NO driverId)
   → DriverMap: single marker, recenters on the dot as it moves
```

The driver's position is already in Redis geo (the existing telemetry pipeline, latest-wins per driverId). The customer never learns the driverId; read-api joins dispatch (Mongo) + geo (Redis) and returns only coordinates.

## Backend changes (read-api)

One endpoint, on the existing `DispatchController` (it already owns `/orders/:orderId/dispatch`):

- **`GET /orders/:orderId/driver-location`** (any authenticated tenant user). Steps:
  1. `const d = await dispatch.byOrder(currentTenant(), orderId)` (full `DispatchView`, internal).
  2. If `!d || !driverLocationVisible(d.status) || !d.driverId` → return `{ location: null }`.
  3. `const pos = await redis.cluster.geopos(driverGeoKey(currentTenant()), d.driverId)` → if empty → `{ location: null }`; else `{ location: { lng: Number(pos[0][0]), lat: Number(pos[0][1]) } }`.
  - **Never returns `driverId`.** Inject `RedisService` into `DispatchController` alongside `DispatchQueryService` (mirrors how `DriversController` uses `RedisService` for `GEOSEARCH`).
- **`driverLocationVisible(status: string): boolean`** — pure helper (exported, unit-tested): `status === DISPATCHED || status === PICKED_UP`. The en-route gate, so a delivered/failed/offered order never leaks a stale position.

Response DTO: `{ location: { lng: number; lat: number } | null }`.

## web-shared additions

- **`getOrderDriverLocation(orderId): Promise<{ lng: number; lat: number } | null>`** (`src/api/client.ts`): GET `/api/read/orders/:orderId/driver-location` via the existing `authedFetch`; unwrap the `{ location }` envelope (returns `null` when absent). Exported from `index.ts`.

## web-customer additions

- **`DriverMap`** (`apps/web-customer/components/driver-map.tsx`): mirrors web-driver's `NearbyMap` — `react-map-gl/mapbox` with the Mapbox `streets-v12` style, a single `Marker` at the driver's `{lng,lat}`, `easeTo` recenter when the position changes, and the **same no-token fallback panel** when `NEXT_PUBLIC_MAPBOX_TOKEN` is absent. Props: `{ center: GeoPoint; driver: { lng: number; lat: number } | null }`. When `driver` is null it renders centered on `center` with a "Locating driver…" note and no marker.
  - Adds `react-map-gl` + `mapbox-gl` to `apps/web-customer/package.json` (already used by web-driver/web-admin) and reuses `NEXT_PUBLIC_MAPBOX_TOKEN`.
- **Order tracking page** (`app/orders/[orderId]/page.tsx`): add `driverLocation` state. In the existing poll `tick`, when `dispatch?.status` is `DISPATCHED`/`PICKED_UP`, call `getOrderDriverLocation(orderId)` and set it; clear it otherwise. Render `<DriverMap center={CITY_CENTERS[tenantId]} driver={driverLocation} />` gated on the en-route window, with a "Driver en route" caption. The existing poll-stop (delivery terminal / order cancelled / MAX_ATTEMPTS) is unchanged.

## Error handling

- Not en route / no ping yet → `{ location: null }` → map shows the city center with "Locating driver…", no marker.
- Poll error → keep the last known position (the existing tick already swallows fetch errors).
- Missing Mapbox token → the fallback panel (same as web-driver), so the page still works without map tiles.

## Testing

- **Vitest (web-shared):** `getOrderDriverLocation` — URL, Bearer, and `{location:null}` → `null` unwrapping; a non-null case returns `{lng,lat}`.
- **read-api:** unit-test `driverLocationVisible` (true for DISPATCHED/PICKED_UP; false for OFFERED/DELIVERED/FAILED/unknown). A controller test (stubbed `DispatchQueryService` + `RedisService`) asserting: en-route status → `{location:{lng,lat}}` with **no `driverId`** in the response; non-en-route status → `{location:null}` and Redis is not queried.
- **Playwright (web-customer):** infra-gated — with an en-route order, the map container renders; calibrated like the other web e2e.

## Success criteria

1. A customer watching an out-for-delivery order sees a map with the driver's dot, updating every ~2s as the driver moves.
2. The response and client never carry `driverId`/`offeredDriverId` — only coordinates.
3. Before dispatch / after delivery, no map (or a "Locating driver…" placeholder while en route without a ping yet).
4. Works without a Mapbox token (fallback panel). web-shared Vitest, read-api tests, typechecks, and web-customer build pass; Playwright is infra-gated.

## Known simplifications (backlog)

- No destination pin / route (orders have no coordinates).
- Polling (matches the page's existing 2s cadence) rather than a location SSE.
- City-center reference rather than the restaurant's real location.
