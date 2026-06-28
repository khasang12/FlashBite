# Phase 4b-i — Design Tokens + Tenant Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat single-layer `theme.css` with a layered design-token system (primitives → semantic → kept Tailwind `@theme` bridge) behind one shared `global.css`, and drive a per-tenant brand accent from a catalog `brandColor`.

**Architecture:** Three CSS files in `packages/web-shared/src/styles/` — `tokens.css` (primitive scales), `theme.css` (semantic role tokens that now reference primitives + the unchanged `@theme inline` bridge), `global.css` (the single entry that imports both plus the base `body` block). A nullable `brand_color` column on `tenants` flows through `TenantView` → `useTenants()` to a new `<TenantBranding/>` client component that overrides `--primary`/`--ring` on `:root` at runtime. Because `@theme inline` maps `--color-primary → var(--primary)`, overriding the variable recolors every `bg-primary`/`ring`/accent app-wide.

**Tech Stack:** Tailwind CSS v4 (`@theme inline`), CSS custom properties, Next.js (4 apps), NestJS + Prisma (Postgres), Zustand, Vitest (web-shared), Jest (shared, live DB).

## Global Constraints

- **Visual parity by default:** every semantic token that currently resolves to a literal hex must resolve to the **same hex** after refactor. The primitive values consumed by semantics are fixed: `--brand-500: #06c167`, `--brand-600: #0b8a43`, `--brand-50: #e7f9ef`, `--gray-950: #0a0a0a`, `--gray-500: #6b7280`, `--gray-200: #ececec`, `--gray-100: #f5f5f5`. Other ramp stops are free (not consumed today).
- **Scope (YAGNI):** light theme only — no dark mode. Accent override touches **only** `--primary` and `--ring`. No typography scale this slice.
- **Brand source:** catalog-driven `brandColor`; missing/null → default `#06c167`.
- **Never read, edit, or stage** `.env`, `.env.example`, or `apps/write-api/requests.http`. (CLI commands that pass `--env-file=.env` are fine — the file is consumed by the tool, not opened by you.)
- **Tenant id == slug** throughout (JWT `tenantId` equals `Tenant.slug`).
- DRY, YAGNI, TDD, frequent commits.

---

## File Structure

- `packages/web-shared/src/styles/tokens.css` *(new)* — primitive scales (gray ramp, brand ramp, spacing, shadow, radius base). No role meaning.
- `packages/web-shared/src/styles/theme.css` *(modify)* — semantic role tokens referencing primitives; `@theme inline` bridge kept verbatim; `--radius` base removed (moves to tokens.css).
- `packages/web-shared/src/styles/global.css` *(new)* — single entry: `@import "./tokens.css"; @import "./theme.css";` + base `body` block.
- `apps/web-{customer,merchant,driver,admin}/app/globals.css` *(modify, all 4 identical today)* — import `global.css` instead of `theme.css`; remove the now-shared `body` block.
- `packages/contracts/src/index.ts` *(modify)* — `TenantView.brandColor?: string`.
- `packages/shared/prisma/schema.prisma` *(modify)* — `Tenant.brandColor String? @map("brand_color")`.
- `packages/shared/prisma/migrations/20260628000000_tenant_brand_color/migration.sql` *(new)* — `ALTER TABLE ADD COLUMN`.
- `packages/shared/src/tenant-catalog.ts` *(modify)* — map `brandColor`.
- `packages/shared/test/tenant-catalog.spec.ts` *(modify)* — assert mapping.
- `apps/identity/src/seed-tenants.ts` *(modify)* — seed berlin/tokyo colors.
- `packages/web-shared/src/components/tenant-branding.tsx` *(new)* + `tenant-branding.test.tsx` *(new)*.
- `packages/web-shared/src/index.ts` *(modify)* — export `TenantBranding`.
- `packages/web-shared/src/components/auth-gate.tsx` *(modify)* — mount `<TenantBranding/>` in the authed branch (single mount point, all 4 apps inherit it; this supersedes the spec's tentative per-app mount).

---

## Task 1: Layered design tokens behind one `global.css`

Pure CSS refactor. There is no CSS unit-test harness, so this task is **not** TDD — its gate is (a) the value-equivalence checklist in the Global Constraints and (b) all 4 apps building cleanly. The variable indirection is mechanically lossless: every changed semantic token points at a primitive whose hex equals the original literal.

**Files:**
- Create: `packages/web-shared/src/styles/tokens.css`
- Create: `packages/web-shared/src/styles/global.css`
- Modify: `packages/web-shared/src/styles/theme.css`
- Modify: `apps/web-customer/app/globals.css`, `apps/web-merchant/app/globals.css`, `apps/web-driver/app/globals.css`, `apps/web-admin/app/globals.css`

**Interfaces:**
- Produces: a `packages/web-shared/src/styles/global.css` entry that defines all `--*` primitives, all semantic role tokens, the `@theme inline` Tailwind bridge, and the base `body` styles. Apps import this one file (after `@import "tailwindcss"`).

- [ ] **Step 1: Create the primitives file**

Create `packages/web-shared/src/styles/tokens.css`:

```css
/* Design primitives: semantic-free scales. No role meaning — see theme.css for roles.
   Stops consumed by semantics are fixed (visual parity); others are free choices. */
:root {
  /* Neutral ramp */
  --gray-50: #fafafa;
  --gray-100: #f5f5f5;   /* secondary / muted / accent */
  --gray-200: #ececec;   /* border / input */
  --gray-300: #d4d4d4;
  --gray-400: #a3a3a3;
  --gray-500: #6b7280;   /* muted-foreground */
  --gray-600: #4b5563;
  --gray-700: #374151;
  --gray-800: #1f2937;
  --gray-900: #111827;
  --gray-950: #0a0a0a;   /* foreground */

  /* Brand ramp (FlashBite green == --brand-500) */
  --brand-50: #e7f9ef;   /* status-accepted-bg */
  --brand-100: #c3f0d8;
  --brand-200: #8fe3b6;
  --brand-300: #57d394;
  --brand-400: #22c074;
  --brand-500: #06c167;  /* primary / ring */
  --brand-600: #0b8a43;  /* status-accepted */
  --brand-700: #0a6e36;
  --brand-800: #08562b;
  --brand-900: #063f20;

  /* Spacing scale */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;

  /* Elevation */
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);

  /* Radius base (consumed by theme.css @theme radius-* calc()) */
  --radius: 0.9rem;
}
```

- [ ] **Step 2: Refactor `theme.css` to reference primitives**

Replace the entire contents of `packages/web-shared/src/styles/theme.css` with (semantic tokens now reference primitives where the hex matches; `--radius` removed — it lives in tokens.css; the `@theme inline` block is unchanged):

```css
:root {
  --background: #ffffff;
  --foreground: var(--gray-950);
  --card: #ffffff;
  --card-foreground: var(--gray-950);
  --popover: #ffffff;
  --popover-foreground: var(--gray-950);
  --primary: var(--brand-500);
  --primary-foreground: #ffffff;
  --secondary: var(--gray-100);
  --secondary-foreground: var(--gray-950);
  --muted: var(--gray-100);
  --muted-foreground: var(--gray-500);
  --accent: var(--gray-100);
  --accent-foreground: var(--gray-950);
  --destructive: #e7000b;
  --destructive-foreground: #ffffff;
  --border: var(--gray-200);
  --input: var(--gray-200);
  --ring: var(--brand-500);

  /* FlashBite order-status palette */
  --status-placed: #b45309;
  --status-placed-bg: #fff7e6;
  --status-accepted: var(--brand-600);
  --status-accepted-bg: var(--brand-50);
  --status-cancelled: #b91c1c;
  --status-cancelled-bg: #fdecec;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);

  --color-status-placed: var(--status-placed);
  --color-status-placed-bg: var(--status-placed-bg);
  --color-status-accepted: var(--status-accepted);
  --color-status-accepted-bg: var(--status-accepted-bg);
  --color-status-cancelled: var(--status-cancelled);
  --color-status-cancelled-bg: var(--status-cancelled-bg);

  --font-sans: var(--font-manrope), ui-sans-serif, system-ui, sans-serif;

  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}
```

- [ ] **Step 3: Create the single `global.css` entry**

Create `packages/web-shared/src/styles/global.css` (imports must precede the rule block; `tokens.css` first so `theme.css`'s `var(--brand-500)` etc. resolve):

```css
@import "./tokens.css";
@import "./theme.css";

/* Shared base layer (previously duplicated in each app's globals.css). */
body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
}
```

- [ ] **Step 4: Point all 4 apps at `global.css` and drop the duplicated body block**

In **each** of `apps/web-customer/app/globals.css`, `apps/web-merchant/app/globals.css`, `apps/web-driver/app/globals.css`, `apps/web-admin/app/globals.css` (all 4 are byte-identical today), replace the whole file with:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "../../../packages/web-shared/src/styles/global.css";

/* Scan shadcn/ui components that live in the shared package so their
   utility classes are generated by Tailwind's content detection. */
@source "../../../packages/web-shared/src";
```

- [ ] **Step 5: Build all 4 apps (the gate)**

Run each (a Next.js production build resolves and inlines the nested `@import` chain through Tailwind v4 and would fail on an unresolved token or a broken `@theme`):

```bash
pnpm --filter web-customer build
pnpm --filter web-merchant build
pnpm --filter web-driver build
pnpm --filter web-admin build
```

Expected: all four exit 0 (`✓ Compiled successfully`). If a build fails because Tailwind v4 does not inline a nested `@import` of a file containing `@theme`, fall back to importing the two layer files directly in each app's `globals.css` (`@import ".../styles/tokens.css"; @import ".../styles/theme.css";`) and keep the `body` block in each app's `globals.css` instead of in `global.css` — but only after confirming the failure; the nested-import path is expected to work.

- [ ] **Step 6: Verify value parity**

Confirm by inspection that the semantic tokens still resolve to the original hexes: `--primary`→`#06c167`, `--ring`→`#06c167`, `--foreground`→`#0a0a0a`, `--secondary`/`--muted`/`--accent`→`#f5f5f5`, `--muted-foreground`→`#6b7280`, `--border`/`--input`→`#ececec`, `--status-accepted`→`#0b8a43`, `--status-accepted-bg`→`#e7f9ef`. Literals (`--background` `#ffffff`, `--destructive` `#e7000b`, status placed/cancelled) are unchanged. This is the visual-parity gate from the Global Constraints.

- [ ] **Step 7: Commit**

```bash
git add packages/web-shared/src/styles/tokens.css packages/web-shared/src/styles/global.css packages/web-shared/src/styles/theme.css apps/web-customer/app/globals.css apps/web-merchant/app/globals.css apps/web-driver/app/globals.css apps/web-admin/app/globals.css
git commit -m "feat(web-shared): layered design tokens behind shared global.css"
```

---

## Task 2: Catalog-driven `brandColor` (contract + DB + service + seed)

**Prerequisite:** local Postgres must be running (`docker compose -f infra/docker-compose.yml up -d postgres`) for the migration, seed, and Jest live-DB test.

**Files:**
- Modify: `packages/contracts/src/index.ts:234-240` (`TenantView`)
- Modify: `packages/shared/prisma/schema.prisma:63-71` (`Tenant`)
- Create: `packages/shared/prisma/migrations/20260628000000_tenant_brand_color/migration.sql`
- Modify: `packages/shared/src/tenant-catalog.ts:25`
- Modify: `packages/shared/test/tenant-catalog.spec.ts`
- Modify: `apps/identity/src/seed-tenants.ts`

**Interfaces:**
- Produces: `TenantView.brandColor?: string` — consumed by Task 3's `<TenantBranding/>`.
- Consumes: existing `TenantCatalogService`, `prisma.tenant` model, `getTenants`/`useTenants` (pass-through, unchanged).

- [ ] **Step 1: Write the failing test**

Add this test to `packages/shared/test/tenant-catalog.spec.ts`, inside the `describe("TenantCatalogService (live DB)", ...)` block (after the existing `it(...)` cases, before the closing `});`):

```ts
  it("maps brandColor from the row (undefined when null)", async () => {
    const withColor = `zzc-${Date.now()}`;
    const without = `zzn-${Date.now()}`;
    try {
      await prisma.tenant.create({ data: { slug: withColor, displayName: "C", lng: 0, lat: 0, status: "active", brandColor: "#123456" } });
      await prisma.tenant.create({ data: { slug: without, displayName: "N", lng: 0, lat: 0, status: "active" } });
      await svc.refresh();
      expect((await svc.get(withColor))?.brandColor).toBe("#123456");
      expect((await svc.get(without))?.brandColor).toBeUndefined();
    } finally {
      await prisma.tenant.deleteMany({ where: { slug: { in: [withColor, without] } } });
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
pnpm exec jest packages/shared/test/tenant-catalog.spec.ts
```
Expected: FAIL — ts-jest reports a type error that `brandColor` does not exist on the Prisma `tenant.create` data / on `TenantView` (the column and field do not exist yet).

- [ ] **Step 3: Add `brandColor` to the `TenantView` contract**

In `packages/contracts/src/index.ts`, change the `TenantView` interface (currently lines 234-240) to:

```ts
export interface TenantView {
  slug: string;
  displayName: string;
  lng: number;
  lat: number;
  status: string;
  /** Per-tenant brand accent (hex). Optional — absent/null tenants use the default brand. */
  brandColor?: string;
}
```

- [ ] **Step 4: Add the column to the Prisma model**

In `packages/shared/prisma/schema.prisma`, change the `Tenant` model to add the `brandColor` field:

```prisma
model Tenant {
  slug        String   @id
  displayName String   @map("display_name")
  lng         Float
  lat         Float
  status      String   @default("active")
  brandColor  String?  @map("brand_color")
  createdAt   DateTime @default(now()) @map("created_at")
  @@map("tenants")
}
```

- [ ] **Step 5: Create the migration**

Create `packages/shared/prisma/migrations/20260628000000_tenant_brand_color/migration.sql`:

```sql
-- Per-tenant brand accent. Nullable: existing tenants fall back to the default brand.
-- The table is not under RLS; the existing `GRANT SELECT ON "tenants" TO flashbite_app`
-- is table-level and already covers this new column (no new grant needed).
ALTER TABLE "tenants" ADD COLUMN "brand_color" TEXT;
```

- [ ] **Step 6: Apply the migration and regenerate the Prisma client**

Run:
```bash
pnpm db:deploy
pnpm db:generate
```
Expected: `db:deploy` reports the `20260628000000_tenant_brand_color` migration applied (or "No pending migrations" only if already applied); `db:generate` reports the client regenerated. The generated client now types `brandColor` on `tenant`.

- [ ] **Step 7: Map `brandColor` in the catalog service**

In `packages/shared/src/tenant-catalog.ts`, change the mapping line (line 25) inside `ensureFresh()`:

```ts
      this.cache = rows.map((r) => ({ slug: r.slug, displayName: r.displayName, lng: r.lng, lat: r.lat, status: r.status, brandColor: r.brandColor ?? undefined }));
```

- [ ] **Step 8: Run the test to verify it passes**

Run:
```bash
pnpm exec jest packages/shared/test/tenant-catalog.spec.ts
```
Expected: PASS (all cases, including the new `maps brandColor` case).

- [ ] **Step 9: Seed visibly-distinct colors**

Replace `SEED_TENANTS` and the upsert `update`/`create` in `apps/identity/src/seed-tenants.ts` so both branches set `brandColor`:

```ts
const SEED_TENANTS = [
  { slug: "berlin", displayName: "Berlin", lng: 13.405, lat: 52.52, brandColor: "#06c167" },
  { slug: "tokyo", displayName: "Tokyo", lng: 139.7, lat: 35.68, brandColor: "#7c3aed" },
];
```

and change the upsert call inside the loop to:

```ts
      await prisma.tenant.upsert({
        where: { slug: t.slug },
        update: { displayName: t.displayName, lng: t.lng, lat: t.lat, status: "active", brandColor: t.brandColor },
        create: { ...t, status: "active" },
      });
```

- [ ] **Step 10: Run the seed**

Run:
```bash
pnpm seed:tenants
```
Expected: `seeded tenant berlin (Berlin)` and `seeded tenant tokyo (Tokyo)`, exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/contracts/src/index.ts packages/shared/prisma/schema.prisma packages/shared/prisma/migrations/20260628000000_tenant_brand_color/migration.sql packages/shared/src/tenant-catalog.ts packages/shared/test/tenant-catalog.spec.ts apps/identity/src/seed-tenants.ts
git commit -m "feat(catalog): per-tenant brandColor column, mapping, and seed"
```

---

## Task 3: `<TenantBranding/>` runtime accent override

**Files:**
- Create: `packages/web-shared/src/components/tenant-branding.tsx`
- Create: `packages/web-shared/src/components/tenant-branding.test.tsx`
- Modify: `packages/web-shared/src/index.ts` (export)
- Modify: `packages/web-shared/src/components/auth-gate.tsx` (mount)

**Interfaces:**
- Consumes: `TenantView.brandColor` (Task 2), `useAuthStore` (`s.claims?.tenantId`), `useTenants()`.
- Produces: `export function TenantBranding(): null` — mounted once inside `AuthGate`'s authed branch; renders nothing.

- [ ] **Step 1: Write the failing test**

Create `packages/web-shared/src/components/tenant-branding.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useAuthStore } from "../store/auth-store";
import { TenantBranding } from "./tenant-branding";

vi.mock("../tenants/use-tenants", () => ({
  useTenants: () => ({
    tenants: [
      { slug: "berlin", displayName: "Berlin", lng: 0, lat: 0, status: "active", brandColor: "#06c167" },
      { slug: "tokyo", displayName: "Tokyo", lng: 0, lat: 0, status: "active", brandColor: "#7c3aed" },
      { slug: "nocolor", displayName: "NoColor", lng: 0, lat: 0, status: "active" },
    ],
    loading: false,
  }),
}));

const root = document.documentElement;
afterEach(() => {
  cleanup();
  root.style.removeProperty("--primary");
  root.style.removeProperty("--ring");
});

describe("TenantBranding", () => {
  it("sets --primary/--ring to the logged-in tenant's brandColor", () => {
    useAuthStore.setState({ claims: { sub: "u", tenantId: "tokyo", role: "driver" } });
    render(<TenantBranding />);
    expect(root.style.getPropertyValue("--primary")).toBe("#7c3aed");
    expect(root.style.getPropertyValue("--ring")).toBe("#7c3aed");
  });

  it("falls back to the default brand when the tenant has no brandColor", () => {
    useAuthStore.setState({ claims: { sub: "u", tenantId: "nocolor", role: "driver" } });
    render(<TenantBranding />);
    expect(root.style.getPropertyValue("--primary")).toBe("#06c167");
  });

  it("removes the override when no tenant is logged in", () => {
    useAuthStore.setState({ claims: null });
    render(<TenantBranding />);
    expect(root.style.getPropertyValue("--primary")).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
pnpm --filter @flashbite/web-shared exec vitest run src/components/tenant-branding.test.tsx
```
Expected: FAIL — cannot resolve `./tenant-branding` (the module does not exist yet).

- [ ] **Step 3: Create the component**

Create `packages/web-shared/src/components/tenant-branding.tsx`:

```tsx
"use client";
import { useEffect } from "react";
import { useAuthStore } from "../store/auth-store";
import { useTenants } from "../tenants/use-tenants";

const DEFAULT_BRAND = "#06c167";

/**
 * Applies the logged-in tenant's brand accent at runtime by overriding the `--primary` and
 * `--ring` custom properties on :root. Because `@theme inline` maps `--color-primary` to
 * `var(--primary)`, this recolors every `bg-primary`/`ring`/accent app-wide. Renders nothing.
 * On logout (no tenant) it removes the overrides so the default brand shows.
 */
export function TenantBranding(): null {
  const tenantId = useAuthStore((s) => s.claims?.tenantId);
  const { tenants } = useTenants();

  useEffect(() => {
    const root = document.documentElement;
    if (!tenantId) {
      root.style.removeProperty("--primary");
      root.style.removeProperty("--ring");
      return;
    }
    const color = tenants.find((t) => t.slug === tenantId)?.brandColor ?? DEFAULT_BRAND;
    root.style.setProperty("--primary", color);
    root.style.setProperty("--ring", color);
    return () => {
      root.style.removeProperty("--primary");
      root.style.removeProperty("--ring");
    };
  }, [tenantId, tenants]);

  return null;
}
```

- [ ] **Step 4: Export it from the package**

In `packages/web-shared/src/index.ts`, add after the `AuthGate` export (line 110):

```ts
export { TenantBranding } from "./components/tenant-branding";
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
pnpm --filter @flashbite/web-shared exec vitest run src/components/tenant-branding.test.tsx
```
Expected: PASS (3 cases).

- [ ] **Step 6: Mount it in `AuthGate`'s authed branch**

In `packages/web-shared/src/components/auth-gate.tsx`, import the component (after the existing imports, around line 5):

```tsx
import { TenantBranding } from "./tenant-branding";
```

and render it inside the final authed `return (...)` (the fragment that currently holds the logout bar and `{children}`), as the first child of the fragment:

```tsx
  return (
    <>
      <TenantBranding />
      <div className="flex items-center justify-end gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
        <span>
          {claims?.role}@{claims?.tenantId}
        </span>
        <Button variant="outline" size="sm" onClick={logout}>
          Log out
        </Button>
      </div>
      {children}
    </>
  );
```

- [ ] **Step 7: Run the full web-shared suite + one app build**

Run:
```bash
pnpm --filter @flashbite/web-shared test
pnpm --filter web-customer build
```
Expected: web-shared Vitest suite all green (existing tests + the 3 new cases); `web-customer` build exits 0 (confirms the `AuthGate` change and the new export compile).

- [ ] **Step 8: Commit**

```bash
git add packages/web-shared/src/components/tenant-branding.tsx packages/web-shared/src/components/tenant-branding.test.tsx packages/web-shared/src/index.ts packages/web-shared/src/components/auth-gate.tsx
git commit -m "feat(web-shared): TenantBranding applies per-tenant accent in AuthGate"
```

---

## Manual verification (after all tasks)

With the stack running, log into `web-driver` (or any app) as a **berlin** user → primary accent is green (`#06c167`); log out and in as a **tokyo** user → primary accent is violet (`#7c3aed`). Logged out, the login screen shows the default green.

## Exit criteria

- One `global.css` entry; tokens layered primitive → semantic; Tailwind classes render identically to today by default (value-parity checklist passes; all 4 apps build).
- `brand_color` column applied via migration; `TenantCatalogService` maps it; seed sets berlin/tokyo colors; Jest catalog test passes.
- `<TenantBranding/>` overrides `--primary`/`--ring` from the catalog, mounted once in `AuthGate`; Vitest cases pass; logging into different tenants visibly recolors the accent.
