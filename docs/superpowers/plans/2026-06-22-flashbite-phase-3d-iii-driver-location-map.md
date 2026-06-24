# Phase 3d-iii — Customer live driver-location map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the assigned driver's live position on a map on the customer order-tracking page while the order is out for delivery, without exposing the driver's identity.

**Architecture:** read-api gains one endpoint that resolves an order's driver server-side (from the dispatch read model) and returns only its current `{lng,lat}` via Redis `GEOPOS`, gated to the en-route window. web-shared gains a client fn. web-customer gains a `DriverMap` (single live marker, mirroring web-driver's `NearbyMap`) polled on the page's existing 2s tick.

**Tech Stack:** NestJS 10 + ioredis (read-api), Next.js 16 + react-map-gl/mapbox-gl (web-customer), Vitest (web-shared), Jest/ts-jest (read-api), Playwright (web-customer e2e).

**Branch:** `phase-3d-iii-driver-location-map` (already created off `main`).

---

## File Structure

**read-api**
- Create `apps/read-api/src/dispatch/driver-location.ts` — pure `driverLocationVisible(status)`.
- Modify `apps/read-api/src/dispatch/dispatch.controller.ts` — `GET /orders/:orderId/driver-location` (inject `RedisService`).
- Modify `apps/read-api/src/dispatch/dispatch.module.ts` — provide `RedisService`.
- Test: `apps/read-api/test/driver-location.spec.ts`.

**web-shared**
- Modify `packages/web-shared/src/api/client.ts` — `getOrderDriverLocation`.
- Modify `packages/web-shared/src/api/client.test.ts`, `packages/web-shared/src/index.ts`.

**web-customer**
- Modify `apps/web-customer/package.json` — add `react-map-gl` + `mapbox-gl`.
- Create `apps/web-customer/components/driver-map.tsx`.
- Modify `apps/web-customer/app/orders/[orderId]/page.tsx`.

**docs**
- Modify `docs/ARCHITECTURE.md`.

---

## Task 1: read-api — driver-location endpoint

**Files:**
- Create: `apps/read-api/src/dispatch/driver-location.ts`
- Modify: `apps/read-api/src/dispatch/dispatch.controller.ts`, `apps/read-api/src/dispatch/dispatch.module.ts`
- Test: `apps/read-api/test/driver-location.spec.ts`

- [ ] **Step 1: Write the failing test** `apps/read-api/test/driver-location.spec.ts`:
```ts
import { runWithAuth } from "@flashbite/tenant-context";
import { DISPATCH_STATUS, driverGeoKey } from "@flashbite/contracts";
import { driverLocationVisible } from "../src/dispatch/driver-location";
import { DispatchController } from "../src/dispatch/dispatch.controller";

describe("driverLocationVisible", () => {
  it("is true only while the driver is en route (DISPATCHED/PICKED_UP)", () => {
    expect(driverLocationVisible(DISPATCH_STATUS.DISPATCHED)).toBe(true);
    expect(driverLocationVisible(DISPATCH_STATUS.PICKED_UP)).toBe(true);
    expect(driverLocationVisible(DISPATCH_STATUS.OFFERED)).toBe(false);
    expect(driverLocationVisible(DISPATCH_STATUS.DELIVERED)).toBe(false);
    expect(driverLocationVisible(DISPATCH_STATUS.FAILED)).toBe(false);
    expect(driverLocationVisible("WAT")).toBe(false);
  });
});

describe("DispatchController.driverLocation", () => {
  const ctx = { tenantId: "berlin", role: "customer", sub: "c-1" };

  it("returns {lng,lat} and NO driverId for an en-route order", async () => {
    const dispatch = { byOrder: async () => ({ status: "DISPATCHED", driverId: "drv-1", orderId: "o-1" }) } as never;
    const geopos = jest.fn(async () => [["13.4", "52.5"]]);
    const redis = { cluster: { geopos } } as never;
    const ctrl = new DispatchController(dispatch, redis);
    const res = await runWithAuth(ctx, () => ctrl.driverLocation("o-1"));
    expect(res).toEqual({ location: { lng: 13.4, lat: 52.5 } });
    expect((res as Record<string, unknown>).driverId).toBeUndefined();
    expect(geopos).toHaveBeenCalledWith(driverGeoKey("berlin"), "drv-1");
  });

  it("returns {location:null} and does not query Redis when not en route", async () => {
    const dispatch = { byOrder: async () => ({ status: "DELIVERED", driverId: "drv-1", orderId: "o-1" }) } as never;
    const geopos = jest.fn(async () => [["1", "2"]]);
    const ctrl = new DispatchController(dispatch, { cluster: { geopos } } as never);
    const res = await runWithAuth(ctx, () => ctrl.driverLocation("o-1"));
    expect(res).toEqual({ location: null });
    expect(geopos).not.toHaveBeenCalled();
  });

  it("returns {location:null} when the driver has no geo position yet", async () => {
    const dispatch = { byOrder: async () => ({ status: "PICKED_UP", driverId: "drv-1", orderId: "o-1" }) } as never;
    const ctrl = new DispatchController(dispatch, { cluster: { geopos: async () => [null] } } as never);
    const res = await runWithAuth(ctx, () => ctrl.driverLocation("o-1"));
    expect(res).toEqual({ location: null });
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `pnpm jest apps/read-api/test/driver-location.spec.ts` (module/method not found).

- [ ] **Step 3: Create the helper** `apps/read-api/src/dispatch/driver-location.ts`:
```ts
import { DISPATCH_STATUS } from "@flashbite/contracts";

/** A driver's live position is shown to the customer only while the order is en route. */
export function driverLocationVisible(status: string): boolean {
  return status === DISPATCH_STATUS.DISPATCHED || status === DISPATCH_STATUS.PICKED_UP;
}

export interface DriverLocation {
  lng: number;
  lat: number;
}
```

- [ ] **Step 4: Add the endpoint** to `apps/read-api/src/dispatch/dispatch.controller.ts`. Add imports + inject `RedisService`; add the method:
```ts
// imports:
import { RedisService } from "@flashbite/shared";
import { ROLES, driverGeoKey, type DispatchView } from "@flashbite/contracts";
import { driverLocationVisible, type DriverLocation } from "./driver-location";

// constructor:
  constructor(
    private readonly dispatch: DispatchQueryService,
    private readonly redis: RedisService,
  ) {}

// new method (any authenticated tenant user; resolves driver server-side, returns coords only):
  @Get("orders/:orderId/driver-location")
  async driverLocation(@Param("orderId") orderId: string): Promise<{ location: DriverLocation | null }> {
    const d = await this.dispatch.byOrder(currentTenant(), orderId);
    if (!d || !d.driverId || !driverLocationVisible(d.status)) return { location: null };
    const pos = (await this.redis.cluster.geopos(driverGeoKey(currentTenant()), d.driverId)) as Array<[string, string] | null>;
    const p = pos?.[0];
    if (!p) return { location: null };
    return { location: { lng: Number(p[0]), lat: Number(p[1]) } };
  }
```
Keep the existing `byOrder` (delivery view) and `forDriver` handlers unchanged.

- [ ] **Step 5: Provide RedisService** in `apps/read-api/src/dispatch/dispatch.module.ts` — add `RedisService` to the import from `@flashbite/shared` and to `providers`:
```ts
import { MongoService, RedisService } from "@flashbite/shared";
// ...
@Module({ controllers: [DispatchController], providers: [DispatchQueryService, MongoService, RedisService, RolesGuard, Reflector] })
```

- [ ] **Step 6: Run test + typecheck**
`pnpm jest apps/read-api/test/driver-location.spec.ts` (expect pass).
`npx tsc --noEmit -p apps/read-api/tsconfig.json` (EXIT 0).

- [ ] **Step 7: Commit**
```bash
git add apps/read-api/src/dispatch/driver-location.ts apps/read-api/src/dispatch/dispatch.controller.ts apps/read-api/src/dispatch/dispatch.module.ts apps/read-api/test/driver-location.spec.ts
git commit -m "feat(read-api): GET /orders/:orderId/driver-location (en-route only, driver identity hidden)"
```

---

## Task 2: web-shared — getOrderDriverLocation

**Files:**
- Modify: `packages/web-shared/src/api/client.ts`, `packages/web-shared/src/api/client.test.ts`, `packages/web-shared/src/index.ts`

- [ ] **Step 1: Write the failing tests** — add `getOrderDriverLocation` to the import-from-`./client` list in `client.test.ts`, and add inside `describe("api client", ...)`:
```ts
  it("getOrderDriverLocation GETs the driver-location read and unwraps the envelope", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ location: { lng: 13.4, lat: 52.5 } }), { status: 200 }));
    const res = await getOrderDriverLocation("o-1");
    expect(res).toEqual({ lng: 13.4, lat: 52.5 });
    expect(lastUrl()).toBe("/api/read/orders/o-1/driver-location");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
  });

  it("getOrderDriverLocation returns null when there is no location", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ location: null }), { status: 200 }));
    expect(await getOrderDriverLocation("o-2")).toBeNull();
  });
```

- [ ] **Step 2: Run, confirm fail** — `pnpm --filter @flashbite/web-shared test -- client`.

- [ ] **Step 3: Implement** — append to `packages/web-shared/src/api/client.ts`:
```ts
/** GET /orders/:orderId/driver-location — the assigned driver's live position while en route, or
 *  null (not en route / no ping yet). The server resolves the driver; no driverId is exposed. */
export async function getOrderDriverLocation(orderId: string): Promise<{ lng: number; lat: number } | null> {
  const res = await authedFetch(`/api/read/orders/${encodeURIComponent(orderId)}/driver-location`);
  if (!res.ok) throw new Error(`getOrderDriverLocation failed: ${res.status}`);
  return ((await res.json()) as { location: { lng: number; lat: number } | null }).location;
}
```

- [ ] **Step 4: Export** — add `getOrderDriverLocation` to the client re-export block in `packages/web-shared/src/index.ts`.

- [ ] **Step 5: Run, confirm pass** — `pnpm --filter @flashbite/web-shared test -- client`.

- [ ] **Step 6: Commit**
```bash
git add packages/web-shared/src/api/client.ts packages/web-shared/src/api/client.test.ts packages/web-shared/src/index.ts
git commit -m "feat(web-shared): getOrderDriverLocation"
```

---

## Task 3: web-customer — Mapbox deps + DriverMap component

**Files:**
- Modify: `apps/web-customer/package.json`
- Create: `apps/web-customer/components/driver-map.tsx`

- [ ] **Step 1: Add the map deps** to `apps/web-customer/package.json` `dependencies` (same versions as web-driver):
```json
    "mapbox-gl": "^3",
    "react-map-gl": "^8",
```
Then install from the repo root: `pnpm install` (expect it to add the two packages to web-customer).

- [ ] **Step 2: Create the component** `apps/web-customer/components/driver-map.tsx` (mirrors web-driver's `NearbyMap`: single marker, `easeTo` recenter, no-token fallback):
```tsx
"use client";
import { useEffect, useRef } from "react";
import { Map, Marker, type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import type { GeoPoint } from "@flashbite/web-shared";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

/** The assigned driver's live position on a map. `driver` is null until the first ping (or when
 *  not en route) — we then center on the city reference and show a "locating" note, no marker. */
export function DriverMap({ center, driver }: { center: GeoPoint; driver: { lng: number; lat: number } | null }) {
  const mapRef = useRef<MapRef>(null);
  const anchor = driver ?? center;

  // Recenter the (uncontrolled) map as the driver moves; fall back to the city center.
  useEffect(() => {
    mapRef.current?.easeTo({ center: [anchor.lng, anchor.lat], duration: 800 });
  }, [anchor.lng, anchor.lat]);

  if (!TOKEN) {
    return (
      <div
        data-testid="map-fallback"
        className="flex h-[300px] items-center justify-center rounded-xl border bg-muted/30 px-6 text-center text-sm text-muted-foreground"
      >
        Set <code className="mx-1 font-mono">NEXT_PUBLIC_MAPBOX_TOKEN</code> to see the live map.
      </div>
    );
  }

  return (
    <div className="relative h-[300px] overflow-hidden rounded-xl border">
      <Map
        ref={mapRef}
        mapboxAccessToken={TOKEN}
        initialViewState={{ longitude: anchor.lng, latitude: anchor.lat, zoom: 13 }}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        style={{ width: "100%", height: "100%" }}
      >
        {driver && (
          <Marker longitude={driver.lng} latitude={driver.lat} anchor="center">
            <span
              aria-label="driver location"
              className="block h-3.5 w-3.5 rounded-full border-2 border-white shadow"
              style={{ backgroundColor: "#06C167" }}
            />
          </Marker>
        )}
      </Map>
      {!driver && (
        <div className="pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow">
          Locating driver…
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck** — `cd apps/web-customer && npx tsc --noEmit` (EXIT 0), then `cd` back to root. (The component is imported by the page in Task 4; tsc won't flag an unused exported component.)

- [ ] **Step 4: Commit**
```bash
git add apps/web-customer/package.json apps/web-customer/components/driver-map.tsx pnpm-lock.yaml
git commit -m "feat(web-customer): DriverMap component + react-map-gl/mapbox deps"
```

---

## Task 4: web-customer — wire the map into the order page

**Files:**
- Modify: `apps/web-customer/app/orders/[orderId]/page.tsx`

- [ ] **Step 1: Imports** — add to the `@flashbite/web-shared` import: `getOrderDriverLocation`, `CITY_CENTERS`, `useAuthStore`, `type Tenant`. Import the component: `import { DriverMap } from "@/components/driver-map";`

- [ ] **Step 2: Tenant + driver-location state** — in `OrderTrackingContent`, add:
```ts
  const tenantId = (useAuthStore((s) => s.claims?.tenantId) ?? "berlin") as Tenant;
  const [driverLocation, setDriverLocation] = useState<{ lng: number; lat: number } | null>(null);
```

- [ ] **Step 3: Poll the location in the existing tick** — inside the `if (o.status === ORDER_STATUS.ACCEPTED)` block, after `setDispatch(nextDispatch)`, add an en-route location fetch (using the freshly-fetched `nextDispatch`, not the stale `dispatch` state):
```ts
        const enRoute =
          nextDispatch?.status === DISPATCH_STATUS.DISPATCHED || nextDispatch?.status === DISPATCH_STATUS.PICKED_UP;
        if (enRoute) {
          const loc = await getOrderDriverLocation(orderId).catch(() => null);
          if (active) setDriverLocation(loc);
        } else if (active) {
          setDriverLocation(null);
        }
```
Place this immediately before the existing `deliveryTerminal` stop check. (The `nextDispatch` local already exists in the tick from Phase 3d-iv.)

- [ ] **Step 4: Render the map** — after the Delivery line block (the `{order.status === ORDER_STATUS.ACCEPTED && (... Delivery ...)}` block), add:
```tsx
                {(dispatch?.status === DISPATCH_STATUS.DISPATCHED || dispatch?.status === DISPATCH_STATUS.PICKED_UP) && (
                  <div className="space-y-1">
                    <div className="text-sm text-muted-foreground">Driver en route</div>
                    <DriverMap center={CITY_CENTERS[tenantId]} driver={driverLocation} />
                  </div>
                )}
```

- [ ] **Step 5: Build to verify** — `pnpm --filter web-customer build` (expect success). If too heavy, fall back to `cd apps/web-customer && npx tsc --noEmit` and report which you ran.

- [ ] **Step 6: Commit**
```bash
git add "apps/web-customer/app/orders/[orderId]/page.tsx"
git commit -m "feat(web-customer): live driver map on order tracking (poll, en-route only)"
```

---

## Task 5: docs + full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Update ARCHITECTURE.md**
- In the §2 `read-api` row, append to its responsibilities: `; the order driver-location read GET /orders/:orderId/driver-location (en-route only, coords-only)`.
- Add a bullet after the "Delivery status on customer + merchant (Phase 3d-iv)" bullet in §3:
```
- **Customer live driver-location map (Phase 3d-iii):** while an order is out for delivery
  (DISPATCHED/PICKED_UP), the customer tracking page polls `GET /orders/:orderId/driver-location` and
  shows the driver's live dot on a Mapbox map (web-customer `DriverMap`, recentering as it moves). The
  endpoint resolves the order's driver server-side and returns only `{lng,lat}` from Redis `GEOPOS`
  (driver identity never reaches the customer). No destination pin / route — orders carry no delivery
  coordinates; the map uses the tenant city center as reference.
```
ASCII only; match surrounding style.

- [ ] **Step 2: Full verification sweep**
```bash
pnpm --filter @flashbite/web-shared test
npx tsc --noEmit -p apps/read-api/tsconfig.json
pnpm jest apps/read-api/test/driver-location.spec.ts packages/contracts
pnpm --filter web-customer build
```
Expect: web-shared Vitest all pass; read-api tsc EXIT 0; jest pass; web-customer build succeeds.

- [ ] **Step 3: Commit**
```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(3d-iii): customer live driver-location map in ARCHITECTURE"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** en-route-gated, driver-identity-hidden `GET /orders/:orderId/driver-location` (GEOPOS) → Task 1; `getOrderDriverLocation` → Task 2; `DriverMap` (single marker, fallback) + deps → Task 3; poll + render gated to DISPATCHED/PICKED_UP, city-center reference → Task 4; docs + verification → Task 5. ✓

**Type consistency:** `driverLocationVisible(status)` defined in Task 1, reused conceptually in Task 4's `enRoute` gate (same two statuses); `{lng,lat}|null` shape consistent across endpoint → client → `DriverMap.driver` prop → page state; `DriverMap` introduced Task 3, consumed Task 4; `RedisService`/`driverGeoKey` are existing `@flashbite/shared`/contracts exports; `CITY_CENTERS`/`Tenant`/`useAuthStore`/`GeoPoint` are existing web-shared exports.

**Constraint surfaced:** the endpoint returns coords only (no driverId), preserving the 3d-iv privacy model; the map shows a driver dot + city-center reference (orders have no destination coords). The customer page poll loop and its stop conditions are unchanged from 3d-iv except the additive location fetch.
