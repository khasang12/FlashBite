# Phase 4b-i — Design Tokens + Tenant Branding (Design)

**Status:** approved (brainstorm) — pending implementation plan
**Slice of:** Phase 4b (frontend polish). This is **4b-i** only. Sibling slices kept separate:
4b-ii error/not-found boundaries + ErrorState/EmptyState, 4b-iii loading & empty states,
4b-iv action-feedback toasts.

## Goal

Replace the flat single-layer `theme.css` with a **layered, best-practice design-token system**
(primitives → semantic → Tailwind bridge) behind one shared `global.css` entry, and use it to drive
**per-tenant brand accents** sourced from the tenant catalog. Existing Tailwind utility classes
(`bg-primary`, `text-muted-foreground`, etc.) keep working unchanged.

## Decisions (locked from brainstorm)

- **Token scope:** focused best-practice — primitive + semantic layers, plus `--space-*`,
  `--radius-*`, `--shadow-*` scales. **Light theme only** (no dark mode — YAGNI). **No** typography
  scale this slice.
- **Brand-color source:** **catalog-driven** — a `brandColor` column on the `tenants` table,
  surfaced via `TenantView`/`getTenants`, applied at runtime as a CSS-var override.
- **Accent surface:** the per-tenant override touches `--primary` and `--ring` only; neutrals stay
  shared. Missing/null `brandColor` → the default brand (`#06c167`).

## Architecture

### 1. Token layers (`packages/web-shared/src/styles/`)

- **`tokens.css` (primitives, new):** semantic-free scales —
  - neutral ramp `--gray-50 … --gray-950`,
  - brand ramp `--brand-50 … --brand-900` (FlashBite green `#06c167` ≈ `--brand-500`),
  - `--space-1 … --space-8`, `--shadow-sm/md/lg`, and the existing radius base `--radius`.
  Primitives carry no role meaning.
- **`theme.css` (semantic, refactored):** the existing role tokens (`--background`, `--foreground`,
  `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`,
  `--ring`, the `--status-*` palette) **now reference primitives** where natural
  (`--primary: var(--brand-500)`, `--ring: var(--brand-500)`, `--background: var(--gray-50)`/white,
  `--muted-foreground: var(--gray-500)`, …). The existing `@theme inline { --color-*: var(--*) }`
  bridge is **kept verbatim** so Tailwind classes resolve unchanged. Visual output stays the same as
  today (same hex values, just sourced through primitives).
- **`global.css` (entry, new):** `@import "./tokens.css"; @import "./theme.css";` plus a small base
  layer (the `body { background/color/font-family }` block currently duplicated in each app's
  `globals.css`, and a default border color). One import point for all apps.

### 2. App wiring (the 4 `apps/web-*/app/globals.css`)

Each app's `globals.css` currently has:
```
@import "tailwindcss";
@import "tw-animate-css";
@import "../../../packages/web-shared/src/styles/theme.css";
@source "../../../packages/web-shared/src";
body { background: var(--background); color: var(--foreground); font-family: var(--font-sans); }
```
Change the `theme.css` import to `global.css`, and **remove the now-duplicated `body { … }` block**
(it moves into `global.css`'s base layer). `@import "tailwindcss"` and `@source` stay per-app
(Tailwind v4 content scanning is per-app). Import order stays: tailwindcss → global.css.

### 3. Catalog-driven brand color (backend)

- **Migration:** add `brand_color TEXT` (nullable) to `tenants`. The table is not under RLS and the
  existing `GRANT SELECT ON "tenants" TO flashbite_app` covers the new column (no new grant).
- **Prisma model:** `Tenant.brandColor String? @map("brand_color")`.
- **`TenantView`** (`@flashbite/contracts`): add `brandColor?: string`.
- **`TenantCatalogService`** mapping (`packages/shared/src/tenant-catalog.ts:25`): include
  `brandColor: r.brandColor ?? undefined`.
- **Seed** (`apps/identity/src/seed-tenants.ts`): curated, visibly-distinct colors —
  `berlin → "#06c167"` (the default green), `tokyo → "#7c3aed"` (violet). upsert update+create both
  set `brandColor`.
- `getTenants()`/`useTenants()` already return `TenantView`, so `brandColor` flows to the frontend
  with no client API change.

### 4. Runtime branding (`<TenantBranding/>`, new, web-shared)

- A `"use client"` component that:
  - reads the logged-in tenant: `useAuthStore((s) => s.claims?.tenantId)` + `useTenants()`,
  - finds the tenant's `brandColor` (fallback `#06c167` if absent),
  - in an effect, sets `document.documentElement.style.setProperty("--primary", color)` and
    `--ring` to the same color; on unmount / no tenant, removes the overrides (resets to default).
- Because `@theme inline` maps `--color-primary → var(--primary)`, overriding `--primary` at
  `:root` re-accents every `bg-primary`/`text-primary`/`ring` usage app-wide at runtime.
- **Mount point:** inside each app's authed tree (where `tenantId` is known) — render
  `<TenantBranding/>` once near the top of each app's page/layout, alongside `AuthGate`. It renders
  nothing (returns `null`).

## Data flow

```
login → JWT tenantId → useTenants() → TenantView.brandColor
      → <TenantBranding/> effect → :root { --primary, --ring } override
      → bg-primary / ring / accents recolor app-wide
```

## Error handling

- `brandColor` null/missing → fall back to `#06c167` (no override removal needed; set the default).
- No tenant in scope (logged out) → remove the override so the default brand shows.
- Invalid color string → browsers ignore an unparseable custom-property value; the cascade falls
  back to the static `--primary` from theme.css. (No runtime validation needed.)

## Testing

- **Unit:**
  - `TenantCatalogService` maps `brandColor` from a row — **jest** (`packages/shared`, live DB;
    extend the existing `tenant-catalog.spec.ts`).
  - `<TenantBranding/>` — **vitest** (`@flashbite/web-shared`, jsdom + @testing-library/react): with
    a tenant whose `brandColor` is set, after render `document.documentElement.style
    .getPropertyValue("--primary")` equals that color; with no tenant, the override is absent/removed.
    Mock `useAuthStore`/`useTenants` as the existing web-shared tests do.
- **Build/visual:** `tsc` on contracts/shared; the 4 apps build; the recolor is verified manually
  (berlin green vs tokyo violet).
- **No new e2e.**

## Affected files

- Create: `packages/web-shared/src/styles/tokens.css`, `…/styles/global.css`,
  `packages/web-shared/src/components/tenant-branding.tsx` (+ test).
- Modify: `packages/web-shared/src/styles/theme.css` (reference primitives; keep `@theme inline`),
  `packages/web-shared/src/index.ts` (export `TenantBranding`),
  `packages/contracts/src/index.ts` (`TenantView.brandColor`),
  `packages/shared/prisma/schema.prisma` (+ migration dir), `packages/shared/src/tenant-catalog.ts`,
  `apps/identity/src/seed-tenants.ts`, the 4 `apps/web-*/app/globals.css`, and the 4 app pages/layouts
  to mount `<TenantBranding/>`.

## Exit criteria

- One `global.css` entry; tokens are layered primitive→semantic; existing Tailwind classes render
  identically to today by default.
- Logging into different tenants visibly recolors the primary accent (berlin green, tokyo violet),
  driven by the catalog `brandColor`.
- Unit tests for the catalog mapping and `<TenantBranding/>` pass; tsc + app builds clean.
