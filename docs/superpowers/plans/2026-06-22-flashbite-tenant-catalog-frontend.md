# Tenant catalog (frontend) — Slice B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frontends consume the DB-backed tenant catalog (`GET /tenants`) instead of the hardcoded web-shared `TENANTS`/`CITY_CENTERS` constants.

**Architecture:** web-shared gains `getTenants()` + a cached `useTenants()` hook. web-admin renders per-tenant maps + header from the fetched catalog; web-driver derives its own city center from it; web-customer is unchanged. The web-shared `TENANTS`/`CITY_CENTERS` constants are removed last (`Tenant` → `string` re-export), keeping the tree green.

**Tech Stack:** Next.js 16 + React 19 + zustand (apps), Vitest + @testing-library/react (web-shared).

**Branch:** `phase-tenant-catalog-frontend` (already created, **stacked on `phase-tenant-catalog-backend`** — needs Slice A's `/tenants` + `TenantView`).

## Global Constraints

- The catalog is fetched from `GET /api/read/tenants` (Slice A, authenticated; all pages are behind `AuthGate`). Response is `TenantView[]` = `{ slug, displayName, lng, lat, status }[]`.
- `useTenants()` fetches **once per app session** (module-level cache + in-flight dedupe); a mid-session change needs a reload (documented).
- The menu (`menu/seed.ts`) is **demo data, not catalog data** — keep it, but make `getMenu`/`getPopular` fall back to the default (berlin) menu for an unknown tenant.
- Removal order: the web-shared `TENANTS`/`CITY_CENTERS` constants are deleted in the LAST task, after admin + driver no longer import them. `Tenant` becomes a `string` re-export from contracts (kept exported).
- Frontend-only; no backend changes. Do NOT modify or stage `apps/write-api/requests.http` (pre-existing unrelated working-tree edit).
- web-customer needs no edit (it only uses `type Tenant` + `getMenu`); just verify its build.

---

## Task 1: web-shared — getTenants client fn

**Files:**
- Modify: `packages/web-shared/src/api/client.ts`, `packages/web-shared/src/index.ts`
- Test: `packages/web-shared/src/api/client.test.ts`

**Interfaces:**
- Produces: `getTenants(): Promise<TenantView[]>`; `TenantView` re-exported from web-shared.

- [ ] **Step 1: Write the failing test** — add `getTenants` to the import-from-`./client` list in `client.test.ts`, and add inside `describe("api client", ...)`:
```ts
  it("getTenants GETs the tenants read with Bearer and returns the catalog", async () => {
    const rows = [{ slug: "berlin", displayName: "Berlin", lng: 13.405, lat: 52.52, status: "active" }];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
    const res = await getTenants();
    expect(res).toEqual(rows);
    expect(lastUrl()).toBe("/api/read/tenants");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
  });
```

- [ ] **Step 2: Run, confirm fail** — `pnpm --filter @flashbite/web-shared test -- client`.

- [ ] **Step 3: Implement** — in `packages/web-shared/src/api/client.ts`: add `TenantView` to the existing type import from `@flashbite/contracts` (the first import line), and append:
```ts
/** GET /tenants - the active tenant catalog (slug, displayName, lng, lat, status). */
export async function getTenants(): Promise<TenantView[]> {
  const res = await authedFetch("/api/read/tenants");
  if (!res.ok) throw new Error(`getTenants failed: ${res.status}`);
  return (await res.json()) as TenantView[];
}
```

- [ ] **Step 4: Export** — in `packages/web-shared/src/index.ts`: add `getTenants` to the client re-export block (the `export { ... } from "./api/client";`), and add near the other contracts type re-exports at the top: `export type { TenantView } from "@flashbite/contracts";`.

- [ ] **Step 5: Run, confirm pass** — `pnpm --filter @flashbite/web-shared test -- client`.

- [ ] **Step 6: Commit**
```bash
git add packages/web-shared/src/api/client.ts packages/web-shared/src/index.ts packages/web-shared/src/api/client.test.ts
git commit -m "feat(web-shared): getTenants client fn + TenantView re-export"
```

---

## Task 2: web-shared — useTenants hook (cached, deduped)

**Files:**
- Create: `packages/web-shared/src/tenants/use-tenants.ts`
- Modify: `packages/web-shared/src/index.ts`
- Test: `packages/web-shared/src/tenants/use-tenants.test.ts`

**Interfaces:**
- Consumes: `getTenants` (Task 1).
- Produces: `useTenants(): { tenants: TenantView[]; loading: boolean }`.

- [ ] **Step 1: Write the failing test** — create `packages/web-shared/src/tenants/use-tenants.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAuthStore } from "../store/auth-store";
import { useTenants } from "./use-tenants";

const fetchMock = vi.fn();
beforeEach(() => {
  useAuthStore.setState({ token: "test-token", claims: { sub: "op", tenantId: "platform", role: "operator" } });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("useTenants", () => {
  // One test: the module-level cache is fresh per test FILE, so this single case
  // exercises both "returns the catalog" and "fetch is deduped across consumers".
  it("fetches the catalog once and shares it across consumers", async () => {
    const rows = [{ slug: "berlin", displayName: "Berlin", lng: 13.405, lat: 52.52, status: "active" }];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
    const a = renderHook(() => useTenants());
    const b = renderHook(() => useTenants());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));
    expect(a.result.current.tenants).toHaveLength(1);
    expect(b.result.current.tenants[0].slug).toBe("berlin");
    const tenantCalls = fetchMock.mock.calls.filter((c) => c[0] === "/api/read/tenants");
    expect(tenantCalls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, confirm fail** — `pnpm --filter @flashbite/web-shared test -- use-tenants`.

- [ ] **Step 3: Implement** — create `packages/web-shared/src/tenants/use-tenants.ts`:
```ts
"use client";
import { useEffect, useState } from "react";
import type { TenantView } from "@flashbite/contracts";
import { getTenants } from "../api/client";

// Module-level cache + in-flight promise: the catalog is read-heavy / write-rare, so we fetch it
// once per app session and share it across every component (deduped). A mid-session change needs
// a reload — consistent with the backend catalog's TTL eventual-consistency model.
let cache: TenantView[] | null = null;
let inflight: Promise<TenantView[]> | null = null;

function load(): Promise<TenantView[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = getTenants()
      .then((t) => { cache = t; return t; })
      .catch((e) => { inflight = null; throw e; }); // allow a later retry on failure
  }
  return inflight;
}

/** The active tenant catalog, fetched once and shared. `loading` is true until the first load settles. */
export function useTenants(): { tenants: TenantView[]; loading: boolean } {
  const [tenants, setTenants] = useState<TenantView[]>(cache ?? []);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    if (cache) { setTenants(cache); setLoading(false); return; }
    let active = true;
    load()
      .then((t) => { if (active) { setTenants(t); setLoading(false); } })
      .catch(() => { if (active) setLoading(false); }); // error -> empty list, not loading
    return () => { active = false; };
  }, []);

  return { tenants, loading };
}
```

- [ ] **Step 4: Export** — in `packages/web-shared/src/index.ts`, add: `export { useTenants } from "./tenants/use-tenants";`.

- [ ] **Step 5: Run, confirm pass** — `pnpm --filter @flashbite/web-shared test -- use-tenants`.

- [ ] **Step 6: Commit**
```bash
git add packages/web-shared/src/tenants/use-tenants.ts packages/web-shared/src/index.ts packages/web-shared/src/tenants/use-tenants.test.ts
git commit -m "feat(web-shared): useTenants hook (fetch-once, deduped catalog)"
```

---

## Task 3: web-admin — render the catalog

**Files:**
- Modify: `apps/web-admin/app/page.tsx`

**Interfaces:**
- Consumes: `useTenants` (Task 2); `TenantMap` takes `{ tenant: string; center: GeoPoint; drivers: NearbyDriver[] }`; `driversByTenant: Record<string, NearbyDriver[]>`.

- [ ] **Step 1: Swap the import** — in `apps/web-admin/app/page.tsx` line 3, change:
```ts
import { AuthGate, TENANTS, CITY_CENTERS, Input, type Tenant } from "@flashbite/web-shared";
```
to:
```ts
import { AuthGate, Input, useTenants } from "@flashbite/web-shared";
```

- [ ] **Step 2: Read the catalog in the component** — in `Dashboard()`, after `const { orders, driversByTenant, errors, handleEvent, resync } = useAdminData();` add:
```ts
  const { tenants, loading: tenantsLoading } = useTenants();
```

- [ ] **Step 3: Header uses display names** — replace the header live line:
```tsx
          <span className="h-2 w-2 rounded-full bg-primary" /> live · {TENANTS.join(" + ")}
```
with:
```tsx
          <span className="h-2 w-2 rounded-full bg-primary" /> live · {tenants.map((t) => t.displayName).join(" + ")}
```

- [ ] **Step 4: Driver maps from the catalog** — replace the `<section aria-label="Driver maps" ...>` block body:
```tsx
        <section aria-label="Driver maps" className="mt-6 grid gap-4 md:grid-cols-2">
          {TENANTS.map((t: Tenant) => (
            <TenantMap key={t} tenant={t} center={CITY_CENTERS[t]} drivers={driversByTenant[t] ?? []} />
          ))}
        </section>
```
with:
```tsx
        <section aria-label="Driver maps" className="mt-6 grid gap-4 md:grid-cols-2">
          {tenantsLoading && tenants.length === 0 ? (
            <div className="text-sm text-muted-foreground">Loading tenants…</div>
          ) : (
            tenants.map((t) => (
              <TenantMap key={t.slug} tenant={t.slug} center={{ lng: t.lng, lat: t.lat }} drivers={driversByTenant[t.slug] ?? []} />
            ))
          )}
        </section>
```

- [ ] **Step 5: Build** — `pnpm --filter web-admin build` (expect success). If too heavy, fall back to `cd apps/web-admin && npx tsc --noEmit` and report which you ran.

- [ ] **Step 6: Commit**
```bash
git add apps/web-admin/app/page.tsx
git commit -m "feat(web-admin): render per-tenant maps + header from the tenant catalog"
```

---

## Task 4: web-driver — own city center from the catalog

**Files:**
- Modify: `apps/web-driver/app/page.tsx`

**Interfaces:**
- Consumes: `useTenants` (Task 2); `useNearbyWatch(center: {lng,lat}, watching: boolean)`.

- [ ] **Step 1: Swap the import** — in `apps/web-driver/app/page.tsx`, in the `@flashbite/web-shared` import block, remove `CITY_CENTERS,` and add `useTenants,` (keep `type Tenant` and everything else). The block's first lines become:
```ts
  AuthGate, useAuthStore, useTenants,
  type Tenant, type DispatchView,
  toNearbyRows,
```
(i.e. `CITY_CENTERS` is gone from the `CITY_CENTERS, toNearbyRows,` line, leaving `toNearbyRows,`).

- [ ] **Step 2: Resolve the center from the catalog** — replace:
```ts
  const center = CITY_CENTERS[tenantId];
  const { nearby } = useNearbyWatch(center, online);
```
with:
```ts
  const { tenants } = useTenants();
  const me = tenants.find((t) => t.slug === tenantId);
  const center = me ? { lng: me.lng, lat: me.lat } : null;
  // Don't poll until the city center is known; pass a placeholder coord while watching is false.
  const { nearby } = useNearbyWatch(center ?? { lng: 0, lat: 0 }, online && center !== null);
```

- [ ] **Step 3: Drop the standalone mapCenter** — remove the line:
```ts
  const mapCenter = self ? { lng: self.lng, lat: self.lat } : center;
```
(the map center is computed inline in the JSX below, where `center` is guaranteed non-null).

- [ ] **Step 4: Gate the map section on a known center** — replace the online map block opener:
```tsx
        {online && (
          <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
```
with:
```tsx
        {online && !center && (
          <div className="rounded-xl border px-5 py-4 text-sm text-muted-foreground">Locating your city…</div>
        )}
        {online && center && (
          <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
```
and inside that block, change the `NearbyMap` center prop from `center={mapCenter}` to:
```tsx
              <NearbyMap center={self ? { lng: self.lng, lat: self.lat } : center} self={self} nearby={others} />
```

- [ ] **Step 5: Build** — `pnpm --filter web-driver build` (expect success). If too heavy, fall back to `cd apps/web-driver && npx tsc --noEmit` and report which you ran.

- [ ] **Step 6: Commit**
```bash
git add apps/web-driver/app/page.tsx
git commit -m "feat(web-driver): derive city center from the tenant catalog"
```

---

## Task 5: web-shared cleanup (remove constants) + menu fallback + docs + full sweep

**Files:**
- Modify: `packages/web-shared/src/store/tenant-store.ts`, `packages/web-shared/src/menu/seed.ts`, `packages/web-shared/src/index.ts`
- Delete: `packages/web-shared/src/geo/city-centers.ts`
- Modify: `packages/web-shared/src/menu/seed.test.ts` (if it exists; else create), `docs/ARCHITECTURE.md`, `README.md`

**Interfaces:**
- Consumes: nothing new. After this task, `Tenant` is `string`; `TENANTS`/`CITY_CENTERS` no longer exist in web-shared.

- [ ] **Step 1: Add the failing menu-fallback test** — in `packages/web-shared/src/menu/seed.test.ts` (create it if absent, with the standard vitest imports), add:
```ts
  it("getMenu falls back to the default menu for an unknown tenant", () => {
    expect(getMenu("berlin").length).toBeGreaterThan(0);
    expect(getMenu("nope-xyz")).toEqual(getMenu("berlin"));
  });
  it("getPopular returns only popular items, with the same fallback", () => {
    expect(getPopular("nope-xyz").every((i) => i.popular)).toBe(true);
    expect(getPopular("nope-xyz")).toEqual(getPopular("berlin"));
  });
```
(Add `getMenu, getPopular` to the test's import from `./seed` if not already imported.)

- [ ] **Step 2: Run, confirm fail** — `pnpm --filter @flashbite/web-shared test -- seed` (fails: unknown tenant currently returns undefined).

- [ ] **Step 3: Make the menu resilient + drop the Tenant import** — replace `packages/web-shared/src/menu/seed.ts` lines 1 and 13-35 so the file reads (keep the `MENUS` data blocks for berlin/tokyo exactly as they are now):
```ts
// (no Tenant import — menus are keyed by tenant slug as a plain string)

export interface MenuItem {
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  category: "pizza" | "burgers" | "sides" | "desserts" | "mains";
  imageUrl?: string;
  popular?: boolean;
}

const DEFAULT_TENANT = "berlin";

const MENUS: Record<string, MenuItem[]> = {
  berlin: [ /* ...unchanged... */ ],
  tokyo: [ /* ...unchanged... */ ],
};

/** Demo storefront menu (not catalog data); unknown tenants fall back to the default menu. */
export function getMenu(tenant: string): MenuItem[] {
  return MENUS[tenant] ?? MENUS[DEFAULT_TENANT];
}

/** Client-side "most chosen" until a backend popular endpoint exists. */
export function getPopular(tenant: string): MenuItem[] {
  return getMenu(tenant).filter((i) => i.popular);
}
```
(Keep the existing berlin/tokyo `MENUS` arrays verbatim — only the surrounding type/signature/fallback change.)

- [ ] **Step 4: Widen `Tenant`** — replace the contents of `packages/web-shared/src/store/tenant-store.ts` with:
```ts
// Tenants are runtime data (the catalog), not a compile-time union. The list/metadata live in the
// DB and are fetched via useTenants(); this is just the type alias the frontends reference.
export type { Tenant } from "@flashbite/contracts";
```

- [ ] **Step 5: Delete the city-centers module** —
```bash
git rm packages/web-shared/src/geo/city-centers.ts
```

- [ ] **Step 6: Fix the index exports** — in `packages/web-shared/src/index.ts`:
  - change `export { TENANTS, type Tenant } from "./store/tenant-store";` to `export type { Tenant } from "./store/tenant-store";`
  - remove the line `export { CITY_CENTERS, type CityCenter } from "./geo/city-centers";`

- [ ] **Step 7: Run web-shared tests** — `pnpm --filter @flashbite/web-shared test` (expect all pass: client/getTenants, useTenants, menu fallback, plus existing).

- [ ] **Step 8: Update docs** (ASCII only, match surrounding style):
  - `docs/ARCHITECTURE.md`: add a sentence to the tenant-catalog bullet that the frontends now consume the catalog via `GET /tenants` + `useTenants()` (admin renders per-tenant maps, driver derives its city center) — no hardcoded tenant list remains in web-shared.
  - `README.md`: extend the tenant-catalog line to note the frontends are catalog-driven (admin maps + driver center fetched, not hardcoded).

- [ ] **Step 9: Full build sweep** — confirm every app builds with the constants gone:
```bash
pnpm --filter web-admin build
pnpm --filter web-driver build
pnpm --filter web-customer build
pnpm --filter web-merchant build
```
Expect all four succeed. (web-customer/web-merchant should need no source change; the build proves the removed exports broke nothing.)

- [ ] **Step 10: Commit**
```bash
git add packages/web-shared/src/store/tenant-store.ts packages/web-shared/src/menu/seed.ts packages/web-shared/src/menu/seed.test.ts packages/web-shared/src/index.ts docs/ARCHITECTURE.md README.md
git rm --cached packages/web-shared/src/geo/city-centers.ts 2>/dev/null || true
git commit -m "refactor(web-shared): drop TENANTS/CITY_CENTERS (catalog-driven); menu fallback; docs"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** `getTenants` → Task 1; `useTenants` (cached/deduped) → Task 2; web-admin per-tenant maps + header → Task 3; web-driver own city center (loading-gated) → Task 4; remove `TENANTS`/`CITY_CENTERS`, `Tenant`→`string`, menu fallback, docs, full build sweep → Task 5. web-customer unchanged (verified by the Task 5 build). ✓

**Green ordering:** constants removed only in Task 5, after admin (T3) + driver (T4) stop importing them; `TenantMap.tenant` is already typed `string` and `driversByTenant` is `Record<string, ...>`, so admin's `t.slug` passes typecheck even while `Tenant` is still the union (T1-T4). `Tenant` stays exported throughout (web-customer keeps compiling).

**Type consistency:** `TenantView` (`slug/displayName/lng/lat/status`) flows contracts → `getTenants` → `useTenants` → admin/driver; `useTenants(): { tenants, loading }` matches its consumers in T3/T4; `useNearbyWatch(center, watching)` keeps its existing signature (driver passes a placeholder coord + `watching=false` until the center loads); menu `getMenu/getPopular(tenant: string)` with the default-tenant fallback is consistent across seed + its test.
