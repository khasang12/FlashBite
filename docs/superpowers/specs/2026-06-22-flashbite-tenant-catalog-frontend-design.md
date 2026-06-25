# Tenant catalog (frontend) — Slice B design

**Goal:** Make the frontends consume the DB-backed tenant catalog instead of the hardcoded web-shared `TENANTS`/`CITY_CENTERS` constants — so the admin console and driver map reflect whatever tenants exist in the catalog, with no code change to add a tenant.

**Builds on:** Slice A (the `tenants` table, `TenantCatalogService`, the `TenantGuard`, contracts `TenantView`, and the authenticated `GET /tenants` endpoint). This is **Slice B** of the "full tenant catalog" work; it removes the last copies of the hardcoded constant (the web-shared ones). Branch `phase-tenant-catalog-frontend`, **stacked on `phase-tenant-catalog-backend`** (needs `/tenants` + `TenantView`).

## Scope

In scope: a web-shared `getTenants()` client fn + a `useTenants()` hook (cached, deduped); removing the web-shared `TENANTS` and `CITY_CENTERS` constants (`Tenant` becomes a `string` re-export); making the menu seed resilient to unknown tenants; rewiring web-admin (per-tenant maps + header) and web-driver (own city center) to the fetched catalog; web-customer is effectively untouched.

Out of scope: a tenant picker on the login screen (tenant still comes from the JWT); a live catalog stream/refresh (fetch-once-per-session is fine); editing tenant metadata from the UI; any backend change (Slice A owns the endpoint).

## Architecture & data flow

```
GET /api/read/tenants  (Slice A; authenticated; pages are behind AuthGate)
        |
  web-shared: getTenants() -> useTenants()  (module-level cache + in-flight promise; fetch once, deduped)
        |                                     returns { tenants: TenantView[], loading }
        v
  web-admin  app/page.tsx   tenants.map(t => <TenantMap tenant={t.slug} center={{lng,lat}} .../>)
                            header: "live - " + tenants.map(t.displayName).join(" + ")
  web-driver app/page.tsx   me = tenants.find(t => t.slug === claims.tenantId)
                            center = me ? {lng,lat} : null  -> NearbyMap (loading until known)
  web-customer              UNCHANGED tenant source (claims.tenantId); no catalog fetch
```

The shift from synchronous constant to fetched data introduces a brief loading state in admin + driver. The hook's module-level cache makes the GET fire once per app session (deduped across components), so re-renders are cheap.

**The menu is demo data, not catalog data.** `getMenu`/`getPopular` (`menu/seed.ts`) are hardcoded storefront content, not tenant metadata; the catalog carries no menus. So Slice B keeps the menu seed but makes it resilient to an unknown tenant (fallback to the default menu), so any catalog tenant still renders a storefront.

## Component changes

**web-shared**
- `api/client.ts` — add `getTenants(): Promise<TenantView[]>` (GET `/api/read/tenants` via `authedFetch`). Re-export `TenantView` (from contracts).
- `hooks/use-tenants.ts` (new) — `useTenants(): { tenants: TenantView[]; loading: boolean }`. Module-level `cache` + in-flight `promise` so the fetch fires once and is shared/deduped across components and apps; `useEffect` hydrates state from the cache/promise.
- `store/tenant-store.ts` — remove `TENANTS` and the union; re-export `type Tenant` from contracts (now `string`) so existing `../store/tenant-store` imports keep resolving.
- `geo/city-centers.ts` — remove `CITY_CENTERS` (and the unused `CityCenter`); delete the file and its index export. `GeoPoint` (`geo/types`) stays and remains the `center` prop type.
- `menu/seed.ts` — `MENUS: Record<string, MenuItem[]>`; `getMenu`/`getPopular` fall back to the default (berlin's) menu for an unknown tenant. Otherwise unchanged.
- `index.ts` — add `getTenants`, `useTenants`, `type TenantView`; remove the `TENANTS` and `CITY_CENTERS` exports; keep `type Tenant`.

**web-admin (`app/page.tsx`)** — `const { tenants, loading } = useTenants();` header uses `tenants.map(t => t.displayName).join(" + ")`; render `tenants.map(t => <TenantMap key={t.slug} tenant={t.slug} center={{ lng: t.lng, lat: t.lat }} drivers={driversByTenant[t.slug] ?? []} />)`; show a skeleton/empty state while `loading && !tenants.length`.

**web-driver (`app/page.tsx`)** — `const { tenants } = useTenants();` then `const me = tenants.find(t => t.slug === tenantId); const center = me ? { lng: me.lng, lat: me.lat } : null;` Gate the map + nearby query on `center` being known (loading placeholder until then) — replaces the synchronous `CITY_CENTERS[tenantId]`.

**web-customer (`app/page.tsx`)** — effectively unchanged: it only uses `type Tenant` (now `string`) and `getMenu(tenantId)`; no `useTenants`. Verify the build is clean.

## Loading / error handling

- `getTenants` fetch error -> `useTenants` returns `tenants: []`, `loading: false`. Admin shows its empty state; driver shows the map placeholder. A `401` flows through the existing `authedFetch` refresh/logout path (unchanged).
- Driver before the catalog loads, or its tenant absent/suspended -> `center` is `null` -> render the loading placeholder, don't run the nearby query until `center` is known. (A suspended own-tenant would already 403 the driver's other calls via the guard; here it degrades gracefully.)
- Empty catalog -> admin renders no maps + an empty state.
- Dedup -> concurrent `useTenants()` mounts share one in-flight promise (module cache); the GET fires once per app session.
- Staleness -> fetch-once-per-session; a tenant added/suspended mid-session appears on reload. Consistent with the backend's TTL eventual-consistency model; no live catalog stream in scope.

## Testing

- **web-shared (Vitest):** `getTenants` — URL `/api/read/tenants`, Bearer header, returns `TenantView[]`; `getMenu`/`getPopular` fallback — a known tenant returns its menu, an unknown tenant returns the default. `useTenants` caching/dedup tested with `renderHook` if the web-shared test env supports React hooks; otherwise the hook stays thin (wraps `getTenants` + the module cache) and is covered by `getTenants` + the app builds + Playwright.
- **Playwright (infra-gated):** admin renders one map per catalog tenant; the driver map centers on its tenant.
- **Builds (the real regression guard):** `pnpm --filter web-admin build`, `web-driver`, `web-customer`, `web-merchant` all succeed with the `TENANTS`/`CITY_CENTERS` constants gone; web-shared Vitest green.

## Success criteria

1. Adding a tenant to the catalog surfaces it in the admin console (and gives that tenant's drivers their map center) on reload — no frontend code change.
2. No `TENANTS`/`CITY_CENTERS` constants remain in web-shared; `Tenant` is a `string` re-export.
3. The customer storefront still renders for any catalog tenant (menu fallback).
4. All four apps build; web-shared Vitest passes; Playwright is infra-gated.

## Known simplifications (backlog)

- Fetch-once-per-session (no live catalog stream); mid-session tenant changes need a reload.
- Menus remain hardcoded demo content with a default fallback — a real system would carry per-tenant menu data.
- No login-screen tenant picker; tenant still comes from the JWT.
