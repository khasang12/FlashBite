# Phase 1d-iii Driver View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/web-driver` — a driver goes online, streams simulated GPS into the telemetry plane, and sees nearby drivers on a Mapbox map + a shared `DataTable`.

**Architecture:** A new standalone Next.js 16 app on port 3102 reusing `@flashbite/web-shared`. New shared code (pure helpers + driver API client) lands in `web-shared` and is Vitest-tested there (the single frontend unit-test home); the app's components are covered by Playwright e2e, matching the `web-customer`/`web-merchant` pattern. The map uses `react-map-gl` over `mapbox-gl` with a token-gated graceful fallback. Telemetry-only — no order integration.

**Tech Stack:** Next.js 16.2.9, React 19.2.4, Tailwind v4, shadcn/ui (via web-shared), `@tanstack/react-table` (via web-shared `DataTable`), `react-map-gl` v8 + `mapbox-gl` v3, Vitest (web-shared), Playwright (web-driver).

**Spec:** `docs/superpowers/specs/2026-06-14-flashbite-phase-1d-iii-driver-view-design.md`

---

## File Structure

**`packages/web-shared` (new/modified):**
- Create `src/geo/random-walk.ts` — pure `randomWalk({lng,lat}, stepDeg)` → next bounded position.
- Create `src/geo/random-walk.test.ts` — Vitest.
- Create `src/geo/city-centers.ts` — `CITY_CENTERS: Record<Tenant, {lng,lat}>`, `CityCenter` type.
- Create `src/geo/city-centers.test.ts` — Vitest.
- Create `src/geo/nearby.ts` — `toNearbyRows(nearby, selfDriverId)` (excludes self), `formatKm(km)`.
- Create `src/geo/nearby.test.ts` — Vitest.
- Modify `src/api/client.ts` — add `NearbyDriver` type, `reportLocation`, `getNearbyDrivers`.
- Modify `src/api/client.test.ts` — add Vitest cases for the two driver fns.
- Modify `src/components/data-table.tsx` — add optional `emptyMessage` prop (default unchanged).
- Modify `src/index.ts` — export the new symbols.

**`apps/web-driver` (new):**
- Config: `package.json`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs`, `next-env.d.ts`, `.gitignore`, `playwright.config.ts`, `.env.example`.
- `app/layout.tsx`, `app/globals.css`, `app/page.tsx`.
- `hooks/use-gps-emitter.ts` — the online GPS loop.
- `components/nearby-table.tsx` — `DataTable` wrapper.
- `components/nearby-map.tsx` — `react-map-gl` map + token fallback.
- `e2e/driver.spec.ts` — Playwright.

**Root (modified):**
- `jest.config.cjs` — add `apps/web-driver/` to `testPathIgnorePatterns`.
- `package.json` — add `dev:web-driver` + `test:e2e:driver` scripts.

---

## Task 1: web-shared — `randomWalk` + `CITY_CENTERS` (pure geo helpers)

**Files:**
- Create: `packages/web-shared/src/geo/random-walk.ts`
- Test: `packages/web-shared/src/geo/random-walk.test.ts`
- Create: `packages/web-shared/src/geo/city-centers.ts`
- Test: `packages/web-shared/src/geo/city-centers.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/web-shared/src/geo/random-walk.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { randomWalk } from "./random-walk";

describe("randomWalk", () => {
  it("returns a position within ±step of the input on each axis", () => {
    const from = { lng: 13.405, lat: 52.52 };
    const step = 0.0008;
    for (let i = 0; i < 200; i++) {
      const next = randomWalk(from, step);
      expect(Math.abs(next.lng - from.lng)).toBeLessThanOrEqual(step);
      expect(Math.abs(next.lat - from.lat)).toBeLessThanOrEqual(step);
    }
  });

  it("clamps to valid lng/lat bounds at the extremes", () => {
    expect(randomWalk({ lng: 180, lat: 90 }, 0.001).lng).toBeLessThanOrEqual(180);
    expect(randomWalk({ lng: 180, lat: 90 }, 0.001).lat).toBeLessThanOrEqual(90);
    expect(randomWalk({ lng: -180, lat: -90 }, 0.001).lng).toBeGreaterThanOrEqual(-180);
    expect(randomWalk({ lng: -180, lat: -90 }, 0.001).lat).toBeGreaterThanOrEqual(-90);
  });

  it("does not mutate the input", () => {
    const from = { lng: 1, lat: 2 };
    randomWalk(from, 0.5);
    expect(from).toEqual({ lng: 1, lat: 2 });
  });
});
```

`packages/web-shared/src/geo/city-centers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { CITY_CENTERS } from "./city-centers";
import { TENANTS } from "../store/tenant-store";

describe("CITY_CENTERS", () => {
  it("has a center for every tenant", () => {
    for (const t of TENANTS) {
      expect(CITY_CENTERS[t]).toBeDefined();
      expect(typeof CITY_CENTERS[t].lng).toBe("number");
      expect(typeof CITY_CENTERS[t].lat).toBe("number");
    }
  });

  it("seeds Berlin and Tokyo at their known centers", () => {
    expect(CITY_CENTERS.berlin).toEqual({ lng: 13.405, lat: 52.52 });
    expect(CITY_CENTERS.tokyo).toEqual({ lng: 139.7, lat: 35.68 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flashbite/web-shared exec vitest run src/geo`
Expected: FAIL — cannot find module `./random-walk` / `./city-centers`.

- [ ] **Step 3: Write the implementations**

`packages/web-shared/src/geo/random-walk.ts`:
```ts
export interface GeoPoint {
  lng: number;
  lat: number;
}

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

// Nudge a position by a bounded random delta on each axis, mirroring
// scripts/stream-gps.sh. Pure: returns a new point, never mutates the input.
export function randomWalk(from: GeoPoint, stepDeg: number): GeoPoint {
  const dLng = (Math.random() * 2 - 1) * stepDeg;
  const dLat = (Math.random() * 2 - 1) * stepDeg;
  return {
    lng: clamp(from.lng + dLng, -180, 180),
    lat: clamp(from.lat + dLat, -90, 90),
  };
}
```

`packages/web-shared/src/geo/city-centers.ts`:
```ts
import type { Tenant } from "../store/tenant-store";
import type { GeoPoint } from "./random-walk";

export type CityCenter = GeoPoint;

// Seed positions for the simulated GPS emitter, per tenant.
export const CITY_CENTERS: Record<Tenant, CityCenter> = {
  berlin: { lng: 13.405, lat: 52.52 },
  tokyo: { lng: 139.7, lat: 35.68 },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @flashbite/web-shared exec vitest run src/geo`
Expected: PASS (random-walk + city-centers).

- [ ] **Step 5: Commit**

```bash
git add packages/web-shared/src/geo/random-walk.ts packages/web-shared/src/geo/random-walk.test.ts packages/web-shared/src/geo/city-centers.ts packages/web-shared/src/geo/city-centers.test.ts
git commit -m "feat(web-shared): randomWalk + CITY_CENTERS geo helpers"
```

---

## Task 2: web-shared — driver API client (`reportLocation`, `getNearbyDrivers`)

**Files:**
- Modify: `packages/web-shared/src/api/client.ts`
- Test: `packages/web-shared/src/api/client.test.ts`

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe("api client", ...)` block in `client.test.ts`, and add the imports `reportLocation, getNearbyDrivers` to the top import from `./client`)

Add to the import line at the top of `client.test.ts`:
```ts
import { placeOrder, getOrder, listOrders, acceptOrder, declineOrder, reportLocation, getNearbyDrivers, type PlaceOrderRequest } from "./client";
```

Append these tests before the closing `});` of the describe block:
```ts
  it("reportLocation POSTs to the read proxy with the tenant header and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ driverId: "drv-1" }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await reportLocation("berlin", "drv-1", { lng: 13.4, lat: 52.5 });

    expect(res).toEqual({ driverId: "drv-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/read/drivers/drv-1/location");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Tenant-ID"]).toBe("berlin");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ lng: 13.4, lat: 52.5 });
  });

  it("reportLocation includes orderId when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ driverId: "drv-1" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await reportLocation("berlin", "drv-1", { lng: 1, lat: 2, orderId: "o-9" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ lng: 1, lat: 2, orderId: "o-9" });
  });

  it("getNearbyDrivers GETs the nearby query with coords + radius and tenant header", async () => {
    const rows = [{ driverId: "drv-7", distanceKm: 0.4, lng: 13.41, lat: 52.53 }];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getNearbyDrivers("tokyo", 139.7, 35.68, 5);

    expect(res).toEqual(rows);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/read/drivers/nearby?lng=139.7&lat=35.68&radiusKm=5");
    expect(init.headers["X-Tenant-ID"]).toBe("tokyo");
  });

  it("getNearbyDrivers defaults radiusKm to 5", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getNearbyDrivers("berlin", 13.4, 52.5);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/read/drivers/nearby?lng=13.4&lat=52.5&radiusKm=5");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flashbite/web-shared exec vitest run src/api/client.test.ts`
Expected: FAIL — `reportLocation`/`getNearbyDrivers` not exported.

- [ ] **Step 3: Add the implementation** (append to the end of `packages/web-shared/src/api/client.ts`; reuse the existing module-private `tenantHeader`)

```ts
export interface NearbyDriver {
  driverId: string;
  distanceKm: number;
  lng: number;
  lat: number;
}

export interface ReportLocationBody {
  lng: number;
  lat: number;
  orderId?: string;
}

/** POST /drivers/:id/location via the same-origin read proxy (telemetry ingest). */
export async function reportLocation(
  tenantId: string,
  driverId: string,
  body: ReportLocationBody,
): Promise<{ driverId: string }> {
  const res = await fetch(`/api/read/drivers/${encodeURIComponent(driverId)}/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tenantHeader(tenantId) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`reportLocation failed: ${res.status}`);
  return (await res.json()) as { driverId: string };
}

/** GET /drivers/nearby via the same-origin read proxy. Distance-sorted ascending. */
export async function getNearbyDrivers(
  tenantId: string,
  lng: number,
  lat: number,
  radiusKm = 5,
): Promise<NearbyDriver[]> {
  const qs = new URLSearchParams({ lng: String(lng), lat: String(lat), radiusKm: String(radiusKm) });
  const res = await fetch(`/api/read/drivers/nearby?${qs.toString()}`, {
    headers: tenantHeader(tenantId),
  });
  if (!res.ok) throw new Error(`getNearbyDrivers failed: ${res.status}`);
  return (await res.json()) as NearbyDriver[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @flashbite/web-shared exec vitest run src/api/client.test.ts`
Expected: PASS (all existing + 4 new cases).

Note: `URLSearchParams` serializes `5` as `radiusKm=5` and `13.4` as `lng=13.4` — the test URLs above assume exactly this ordering (`lng`, `lat`, `radiusKm`), which matches the insertion order.

- [ ] **Step 5: Commit**

```bash
git add packages/web-shared/src/api/client.ts packages/web-shared/src/api/client.test.ts
git commit -m "feat(web-shared): driver API client — reportLocation + getNearbyDrivers"
```

---

## Task 3: web-shared — `toNearbyRows` + `formatKm`, `emptyMessage` on DataTable, exports

**Files:**
- Create: `packages/web-shared/src/geo/nearby.ts`
- Test: `packages/web-shared/src/geo/nearby.test.ts`
- Modify: `packages/web-shared/src/components/data-table.tsx`
- Modify: `packages/web-shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/web-shared/src/geo/nearby.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toNearbyRows, formatKm } from "./nearby";
import type { NearbyDriver } from "../api/client";

const drivers: NearbyDriver[] = [
  { driverId: "drv-1", distanceKm: 0, lng: 13.4, lat: 52.5 },
  { driverId: "drv-7", distanceKm: 0.42, lng: 13.41, lat: 52.53 },
  { driverId: "drv-3", distanceKm: 1.2, lng: 13.39, lat: 52.51 },
];

describe("toNearbyRows", () => {
  it("excludes the caller's own driverId", () => {
    const rows = toNearbyRows(drivers, "drv-1");
    expect(rows.map((r) => r.driverId)).toEqual(["drv-7", "drv-3"]);
  });

  it("returns all rows when the caller is not present", () => {
    expect(toNearbyRows(drivers, "drv-99")).toHaveLength(3);
  });

  it("returns an empty array for empty input", () => {
    expect(toNearbyRows([], "drv-1")).toEqual([]);
  });
});

describe("formatKm", () => {
  it("formats kilometres to 2 decimals with a unit", () => {
    expect(formatKm(0.42)).toBe("0.42 km");
    expect(formatKm(1.2)).toBe("1.20 km");
    expect(formatKm(0)).toBe("0.00 km");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flashbite/web-shared exec vitest run src/geo/nearby.test.ts`
Expected: FAIL — cannot find module `./nearby`.

- [ ] **Step 3: Write the implementation**

`packages/web-shared/src/geo/nearby.ts`:
```ts
import type { NearbyDriver } from "../api/client";

// Drop the caller's own ping from the nearby list (the backend GEOSEARCH may
// include the caller). Order is preserved (backend already sorts by distance).
export function toNearbyRows(nearby: NearbyDriver[], selfDriverId: string): NearbyDriver[] {
  return nearby.filter((d) => d.driverId !== selfDriverId);
}

export function formatKm(km: number): string {
  return `${km.toFixed(2)} km`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flashbite/web-shared exec vitest run src/geo/nearby.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `emptyMessage` to DataTable**

In `packages/web-shared/src/components/data-table.tsx`, extend the props interface — add `emptyMessage` after `pageSize`:
```ts
export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  initialSorting?: SortingState;
  globalFilter?: string;
  onRowClick?: (row: TData) => void;
  pageSize?: number;
  emptyMessage?: string;
}
```

Add it to the destructured params (after `pageSize = 10,`):
```ts
  pageSize = 10,
  emptyMessage = "No orders yet.",
```

Replace the hardcoded empty-state text:
```tsx
            <TableCell
              colSpan={columns.length}
              className="h-24 text-center text-muted-foreground"
            >
              {emptyMessage}
            </TableCell>
```

(The default keeps `web-merchant`'s existing copy unchanged.)

- [ ] **Step 6: Wire exports** in `packages/web-shared/src/index.ts`

Replace the api/client export line:
```ts
export { placeOrder, getOrder, listOrders, acceptOrder, declineOrder, type PlaceOrderRequest } from "./api/client";
```
with:
```ts
export {
  placeOrder, getOrder, listOrders, acceptOrder, declineOrder,
  reportLocation, getNearbyDrivers,
  type PlaceOrderRequest, type NearbyDriver, type ReportLocationBody,
} from "./api/client";
```

Add these new export lines (e.g. after the `useCartStore` line):
```ts
export { randomWalk, type GeoPoint } from "./geo/random-walk";
export { CITY_CENTERS, type CityCenter } from "./geo/city-centers";
export { toNearbyRows, formatKm } from "./geo/nearby";
```

- [ ] **Step 7: Verify the whole web-shared suite passes**

Run: `pnpm --filter @flashbite/web-shared test`
Expected: PASS (all suites green).

- [ ] **Step 8: Commit**

```bash
git add packages/web-shared/src/geo/nearby.ts packages/web-shared/src/geo/nearby.test.ts packages/web-shared/src/components/data-table.tsx packages/web-shared/src/index.ts
git commit -m "feat(web-shared): toNearbyRows/formatKm + DataTable emptyMessage + exports"
```

---

## Task 4: Scaffold `apps/web-driver` (config, layout, placeholder page, root wiring)

**Files:**
- Create: all `apps/web-driver` config files + `app/` shell (listed below)
- Modify: `jest.config.cjs`, `package.json` (root)

- [ ] **Step 1: Create `apps/web-driver/package.json`**

```json
{
  "name": "web-driver",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3102",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "echo \"no unit tests in web-driver\"",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@flashbite/web-shared": "workspace:*",
    "mapbox-gl": "^3",
    "next": "16.2.9",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "react-map-gl": "^8",
    "tw-animate-css": "^1.4.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.60.0",
    "@tailwindcss/postcss": "^4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.2.9",
    "tailwindcss": "^4",
    "typescript": "^5"
  }
}
```

- [ ] **Step 2: Create the config files** (copies of the `web-merchant` equivalents)

`apps/web-driver/next.config.ts`:
```ts
import type { NextConfig } from "next";

const WRITE_API = process.env.WRITE_API_ORIGIN ?? "http://localhost:3001";
const READ_API = process.env.READ_API_ORIGIN ?? "http://localhost:3002";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/write/:path*", destination: `${WRITE_API}/:path*` },
      { source: "/api/read/:path*", destination: `${READ_API}/:path*` },
    ];
  },
};

export default nextConfig;
```

`apps/web-driver/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts"
  ],
  "exclude": ["node_modules"]
}
```

`apps/web-driver/postcss.config.mjs`:
```js
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

`apps/web-driver/eslint.config.mjs`:
```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
```

`apps/web-driver/next-env.d.ts`:
```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
```

`apps/web-driver/.gitignore` (copy `apps/web-merchant/.gitignore` verbatim):
```
# See https://help.github.com/articles/ignoring-files/ for more about ignoring files.

# dependencies
/node_modules
/.pnp
.pnp.*
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/versions

# testing
/coverage

# next.js
/.next/
/out/

# production
/build

# misc
.DS_Store
*.pem

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# env files (can opt-in for committing if needed)
.env*

# vercel
.vercel

# typescript
*.tsbuildinfo
next-env.d.ts

# playwright
playwright-report/
test-results/
```

`apps/web-driver/.env.example`:
```
# Public Mapbox token for the driver map (NearbyMap). Without it, the map shows a
# fallback panel and the emitter + table still work. Get one at https://account.mapbox.com/
NEXT_PUBLIC_MAPBOX_TOKEN=
```

- [ ] **Step 3: Create the app shell**

`apps/web-driver/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
});

export const metadata: Metadata = {
  title: "FlashBite Driver",
  description: "Go online and stream your location.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${manrope.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
```

`apps/web-driver/app/globals.css`:
```css
@import "tailwindcss";
@import "tw-animate-css";
@import "../../../packages/web-shared/src/styles/theme.css";

/* Scan shadcn/ui components that live in the shared package so their
   utility classes are generated by Tailwind's content detection. */
@source "../../../packages/web-shared/src";

body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
}
```

`apps/web-driver/app/page.tsx` (placeholder — replaced in Task 8):
```tsx
export default function DriverPage() {
  return <main className="p-6">web-driver scaffold</main>;
}
```

- [ ] **Step 4: Add `apps/web-driver/` to the root Jest ignore list**

In `jest.config.cjs`, change:
```js
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/apps/web-customer/", "<rootDir>/apps/web-merchant/"],
```
to:
```js
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/apps/web-customer/", "<rootDir>/apps/web-merchant/", "<rootDir>/apps/web-driver/"],
```

- [ ] **Step 5: Add root scripts** in `package.json` (root)

After the `"dev:web-merchant": ...` line add:
```json
    "dev:web-driver": "pnpm --filter web-driver dev",
```
After the `"test:e2e:merchant": ...` line add (note: add a comma to the previous line):
```json
    "test:e2e:driver": "pnpm --filter web-driver test:e2e"
```

- [ ] **Step 6: Install dependencies**

Run: `pnpm install`
Expected: resolves `web-driver` workspace, installs `next`, `react`, `mapbox-gl`, `react-map-gl`, etc. No errors.

- [ ] **Step 7: Verify scaffold builds and root tests still pass**

Run: `pnpm --filter web-driver build`
Expected: build succeeds (compiles the placeholder page).
Run: `pnpm test`
Expected: PASS — backend suites unaffected; `apps/web-driver` is ignored.

- [ ] **Step 8: Commit**

```bash
git add apps/web-driver jest.config.cjs package.json pnpm-lock.yaml
git commit -m "feat(web-driver): scaffold Next.js app on :3102 + root wiring"
```

---

## Task 5: `useGpsEmitter` hook (online GPS loop)

**Files:**
- Create: `apps/web-driver/hooks/use-gps-emitter.ts`

**Context:** This hook owns the online loop. While `online`, every `TICK_MS` it random-walks the position (seeded at the tenant city center), POSTs it via `reportLocation`, then refreshes the nearby list. It must stop cleanly on toggle-off/unmount and survive transient `reportLocation`/`getNearbyDrivers` failures. No unit test (covered by e2e, per the testing strategy); keep it small and correct.

- [ ] **Step 1: Write the hook**

`apps/web-driver/hooks/use-gps-emitter.ts`:
```ts
"use client";
import { useEffect, useState } from "react";
import {
  reportLocation,
  getNearbyDrivers,
  randomWalk,
  CITY_CENTERS,
  type GeoPoint,
  type NearbyDriver,
  type Tenant,
} from "@flashbite/web-shared";

const TICK_MS = 2000;
const STEP_DEG = 0.0008;
const RADIUS_KM = 5;

export interface GpsState {
  position: GeoPoint | null;
  nearby: NearbyDriver[];
  pings: number;
  reconnecting: boolean;
}

const IDLE: GpsState = { position: null, nearby: [], pings: 0, reconnecting: false };

export function useGpsEmitter(tenant: Tenant, driverId: string, online: boolean): GpsState {
  const [state, setState] = useState<GpsState>(IDLE);

  useEffect(() => {
    if (!online) {
      setState(IDLE);
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let pos: GeoPoint = { ...CITY_CENTERS[tenant] };
    let pings = 0;

    const tick = async (): Promise<void> => {
      pos = randomWalk(pos, STEP_DEG);

      let reconnecting = false;
      try {
        await reportLocation(tenant, driverId, { lng: pos.lng, lat: pos.lat });
        pings += 1;
      } catch {
        reconnecting = true; // transient — keep looping
      }

      let fetched: NearbyDriver[] | null = null;
      try {
        fetched = await getNearbyDrivers(tenant, pos.lng, pos.lat, RADIUS_KM);
      } catch {
        fetched = null; // keep last results
      }

      if (!active) return;
      setState((prev) => ({
        position: { ...pos },
        nearby: fetched ?? prev.nearby,
        pings,
        reconnecting,
      }));
      timer = setTimeout(() => void tick(), TICK_MS);
    };

    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [tenant, driverId, online]);

  return state;
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm --filter web-driver exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web-driver/hooks/use-gps-emitter.ts
git commit -m "feat(web-driver): useGpsEmitter online GPS loop"
```

---

## Task 6: `NearbyTable` component (shared DataTable)

**Files:**
- Create: `apps/web-driver/components/nearby-table.tsx`

- [ ] **Step 1: Write the component**

`apps/web-driver/components/nearby-table.tsx`:
```tsx
"use client";
import { DataTable, formatKm, type ColumnDef, type NearbyDriver } from "@flashbite/web-shared";

const columns: ColumnDef<NearbyDriver>[] = [
  {
    id: "driver",
    accessorKey: "driverId",
    header: "Driver",
    cell: ({ row }) => <span className="font-semibold">{row.original.driverId}</span>,
  },
  {
    id: "distance",
    accessorKey: "distanceKm",
    header: "Distance",
    cell: ({ row }) => <span className="text-muted-foreground">{formatKm(row.original.distanceKm)}</span>,
  },
];

export function NearbyTable({ data }: { data: NearbyDriver[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      initialSorting={[{ id: "distance", desc: false }]}
      emptyMessage="No nearby drivers."
    />
  );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm --filter web-driver exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web-driver/components/nearby-table.tsx
git commit -m "feat(web-driver): NearbyTable via shared DataTable"
```

---

## Task 7: `NearbyMap` component (react-map-gl + token fallback)

**Files:**
- Create: `apps/web-driver/components/nearby-map.tsx`

**Context:** `react-map-gl` v8 exposes the Mapbox bindings under the `react-map-gl/mapbox` entry point and `mapbox-gl` v3 ships its own types. The map is controlled (auto-follows the driver by recentering on `position`). When `NEXT_PUBLIC_MAPBOX_TOKEN` is unset, render the fallback panel instead of the map. `NEXT_PUBLIC_` vars are inlined at build time by Next.

- [ ] **Step 1: Write the component**

`apps/web-driver/components/nearby-map.tsx`:
```tsx
"use client";
import { Map, Marker } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import type { GeoPoint, NearbyDriver } from "@flashbite/web-shared";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export function NearbyMap({
  position,
  nearby,
}: {
  position: GeoPoint | null;
  nearby: NearbyDriver[];
}) {
  if (!TOKEN) {
    return (
      <div
        data-testid="map-fallback"
        className="flex h-[360px] items-center justify-center rounded-xl border bg-muted/30 px-6 text-center text-sm text-muted-foreground"
      >
        Set <code className="mx-1 font-mono">NEXT_PUBLIC_MAPBOX_TOKEN</code> to see the live map.
      </div>
    );
  }
  if (!position) return null;

  return (
    <div className="h-[360px] overflow-hidden rounded-xl border">
      <Map
        mapboxAccessToken={TOKEN}
        longitude={position.lng}
        latitude={position.lat}
        zoom={13}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        style={{ width: "100%", height: "100%" }}
      >
        <Marker longitude={position.lng} latitude={position.lat} color="#06C167" />
        {nearby.map((d) => (
          <Marker key={d.driverId} longitude={d.lng} latitude={d.lat} color="#0f172a" />
        ))}
      </Map>
    </div>
  );
}
```

- [ ] **Step 2: Verify the import path against the installed package**

Run: `node -e "console.log(Object.keys(require('apps/web-driver/node_modules/react-map-gl/package.json').exports ?? {}))" 2>/dev/null || cat node_modules/react-map-gl/package.json | grep -A20 '\"exports\"'`
Expected: an export entry for `./mapbox`. If the installed major differs and `react-map-gl/mapbox` is absent, fall back to `import Map, { Marker } from "react-map-gl"` (v7 default export) — but `^8` resolves `react-map-gl/mapbox`.

- [ ] **Step 3: Verify it type-checks**

Run: `pnpm --filter web-driver exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web-driver/components/nearby-map.tsx
git commit -m "feat(web-driver): NearbyMap (react-map-gl) with token fallback"
```

---

## Task 8: Driver page (pickers + online toggle + map + table)

**Files:**
- Modify: `apps/web-driver/app/page.tsx`

**Context:** Replace the placeholder. The page wires the driver-id picker, tenant switcher, online toggle, and `useGpsEmitter`, rendering `NearbyMap` + `NearbyTable` when online. The tenant select is rendered only after mount (and the tenant store rehydrated) to avoid a hydration mismatch, since the store uses `skipHydration`.

- [ ] **Step 1: Write the page**

`apps/web-driver/app/page.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";
import {
  useTenantStore, TENANTS, type Tenant,
  toNearbyRows,
  Button,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@flashbite/web-shared";
import { useGpsEmitter } from "@/hooks/use-gps-emitter";
import { NearbyMap } from "@/components/nearby-map";
import { NearbyTable } from "@/components/nearby-table";

const DRIVERS = ["drv-1", "drv-2", "drv-3", "drv-4"];

export default function DriverPage() {
  const tenant = useTenantStore((s) => s.tenant);
  const setTenant = useTenantStore((s) => s.setTenant);
  const [mounted, setMounted] = useState(false);
  const [driverId, setDriverId] = useState("drv-1");
  const [online, setOnline] = useState(false);

  useEffect(() => {
    void useTenantStore.persist.rehydrate();
    setMounted(true);
  }, []);

  const { position, nearby, pings, reconnecting } = useGpsEmitter(tenant, driverId, online);
  const rows = toNearbyRows(nearby, driverId);

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="text-lg font-extrabold">
          flashbite <span className="text-muted-foreground font-semibold">driver</span>
        </div>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Select value={driverId} onValueChange={setDriverId}>
            <SelectTrigger className="w-28" aria-label="Select driver">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DRIVERS.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mounted && (
            <Select value={tenant} onValueChange={(v) => setTenant(v as Tenant)}>
              <SelectTrigger className="w-28" aria-label="Select city">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TENANTS.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-6 flex items-center justify-between rounded-xl border px-5 py-4">
          {online ? (
            <div className="flex items-center gap-3">
              <span className="relative inline-flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
              </span>
              <div>
                <div className="font-bold">Online — streaming GPS</div>
                <div className="text-xs text-muted-foreground">
                  {driverId} · {pings} pings sent
                  {position ? ` · ${position.lng.toFixed(4)}, ${position.lat.toFixed(4)}` : ""}
                  {reconnecting ? " · reconnecting…" : ""}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Offline — go online to start streaming your location.</div>
          )}
          <Button variant={online ? "secondary" : "default"} onClick={() => setOnline((v) => !v)}>
            {online ? "Go offline" : "Go online"}
          </Button>
        </div>

        {online && (
          <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Nearby · 5km radius
              </div>
              <NearbyMap position={position} nearby={rows} />
            </section>
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Nearby drivers ({rows.length})
              </div>
              <NearbyTable data={rows} />
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Verify build + lint**

Run: `pnpm --filter web-driver build`
Expected: build succeeds.
Run: `pnpm --filter web-driver lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web-driver/app/page.tsx
git commit -m "feat(web-driver): driver page — pickers, online toggle, map + table"
```

---

## Task 9: Playwright e2e + config

**Files:**
- Create: `apps/web-driver/playwright.config.ts`
- Create: `apps/web-driver/e2e/driver.spec.ts`

**Context:** e2e needs the backend telemetry plane running: `pnpm infra:up` + `pnpm dev:read-api` + `pnpm dev:telemetry`. Playwright only starts the web app. The map renders its fallback (no token in CI), so the test asserts streaming + the nearby section, not map tiles.

- [ ] **Step 1: Create the Playwright config**

`apps/web-driver/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

// E2E requires the telemetry backend running (Playwright only starts the web app):
//   pnpm infra:up && pnpm dev:read-api & pnpm dev:telemetry
// Then: pnpm test:e2e:driver
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3102" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3102",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

- [ ] **Step 2: Write the e2e spec**

`apps/web-driver/e2e/driver.spec.ts`:
```ts
import { test, expect } from "@playwright/test";

test("offline by default — no nearby section until online", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/offline/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /go online/i })).toBeVisible();
  await expect(page.getByText(/nearby · 5km radius/i)).toHaveCount(0);
});

test("going online streams a location ping (202) and shows the nearby section", async ({ page }) => {
  await page.goto("/");

  const ping = page.waitForResponse(
    (r) =>
      /\/api\/read\/drivers\/.+\/location$/.test(r.url()) &&
      r.request().method() === "POST" &&
      r.status() === 202,
    { timeout: 30_000 },
  );

  await page.getByRole("button", { name: /go online/i }).click();

  const res = await ping;
  expect(res.status()).toBe(202);

  await expect(page.getByText(/streaming gps/i)).toBeVisible();
  await expect(page.getByText(/nearby · 5km radius/i)).toBeVisible();
  // Nearby readout renders (table or its empty state) once a refresh completes.
  await expect(page.getByText(/nearby drivers \(/i)).toBeVisible();
});
```

- [ ] **Step 3: Run the e2e suite** (with infra + read-api + telemetry up)

Setup (separate terminals or background):
```bash
pnpm infra:up
pnpm dev:read-api &
pnpm dev:telemetry &
```
Run: `pnpm test:e2e:driver`
Expected: both tests PASS (the second asserts a 202 ping + the nearby section).

- [ ] **Step 4: Commit**

```bash
git add apps/web-driver/playwright.config.ts apps/web-driver/e2e/driver.spec.ts
git commit -m "test(web-driver): Playwright e2e — offline default + online ping"
```

---

## Final Verification

- [ ] `pnpm --filter @flashbite/web-shared test` — all Vitest suites pass.
- [ ] `pnpm test` — backend suites pass; web apps ignored.
- [ ] `pnpm --filter web-driver build` — production build succeeds.
- [ ] `pnpm --filter web-driver lint` — clean.
- [ ] `pnpm test:e2e:driver` (with infra + read-api + telemetry up) — e2e passes.
- [ ] Manual smoke (optional, needs a real `NEXT_PUBLIC_MAPBOX_TOKEN` in `apps/web-driver/.env.local`): `pnpm dev:web-driver`, open http://localhost:3102, go online, confirm the map renders with the green self marker recentering as pings fire; run `scripts/stream-gps.sh` for a second driver to populate the table/map.
