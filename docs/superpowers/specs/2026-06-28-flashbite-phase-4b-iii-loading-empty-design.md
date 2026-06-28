# Phase 4b-iii — Loading skeletons + `EmptyState` (Design)

**Status:** approved (brainstorm) — pending implementation plan
**Slice of:** Phase 4b (frontend polish). This is **4b-iii** only. Siblings: 4b-ii error/not-found
boundaries (done), 4b-iv action-feedback toasts.

## Goal

Give the frontends a consistent "nothing here yet" and "still loading" experience: a shared
`EmptyState` (the neutral sibling of 4b-ii's `ErrorState`) and real loading skeletons, unified
through the shared `DataTable` so the three list tables get a consistent **loading → empty → data**
progression — plus skeleton map-cards on admin and an empty-cart on checkout.

## Decisions (locked from brainstorm)

- **`EmptyState` vs `ErrorState`:** failures stay `ErrorState` (bordered destructive/neutral alert
  card); "nothing here yet" becomes `EmptyState` (lighter — no card chrome; the container provides
  it). `DataTable`'s plain `emptyMessage` text row is replaced by `EmptyState`.
- **Skeletons via `DataTable`:** a `loading` prop on the shared `DataTable` drives skeleton rows for
  all three tables (merchant orders, admin orders, driver nearby) from one place.
- **Surface scope:** the three tables + admin maps "Loading tenants…" → skeleton cards + checkout
  empty-cart. **Out:** order-tracking page (already has a skeleton + domain status), customer
  storefront (local synchronous seed), driver "offline / waiting for an offer" (domain status), admin
  stat-card/chart skeletons, toasts (4b-iv).
- **Skeleton row count:** fixed at 5.

## Architecture

### 1. `EmptyState` (`packages/web-shared/src/components/empty-state.tsx`, new)

Presentational, lighter than `ErrorState` (no border/`bg-card`), so it sits cleanly inside a table
cell or an existing card. Reuses the `ErrorStateAction` type and the button/link action rendering
idiom from `ErrorState`.

```tsx
"use client";
import { Inbox } from "lucide-react";
import type { ReactNode, ReactElement } from "react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import type { ErrorStateAction } from "./error-state";

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: string;
  action?: ErrorStateAction;
  icon?: ReactNode;
  className?: string;
}): ReactElement {
  const actionEl = action
    ? action.href
      ? <Button asChild variant="outline" size="sm"><a href={action.href}>{action.label}</a></Button>
      : <Button variant="outline" size="sm" onClick={action.onClick}>{action.label}</Button>
    : null;
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      <span className="text-muted-foreground" aria-hidden>{icon ?? <Inbox className="h-8 w-8" />}</span>
      <p className="font-medium">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {actionEl && <div className="pt-1">{actionEl}</div>}
    </div>
  );
}
```

`title` is required (empty copy is always contextual). Default icon lucide `Inbox`. Exported from
`packages/web-shared/src/index.ts` (`export { EmptyState } from "./components/empty-state";`).

### 2. `DataTable` gets `loading` + renders `EmptyState` (`packages/web-shared/src/components/data-table.tsx`)

- Add `loading?: boolean` to `DataTableProps`.
- The `<TableBody>` becomes three-way:
  - **`loading`** → 5 skeleton rows. Each row is a `<TableRow>` with one `<TableCell>` per column,
    each holding `<Skeleton className="h-4 w-2/3" />` (the existing `Skeleton` primitive).
  - **settled & empty** (`rows.length === 0`) → the existing spanning `<TableCell colSpan>` now holds
    `<EmptyState title={emptyMessage} />` instead of the bare `{emptyMessage}` text.
  - **else** → data rows (unchanged).
- `emptyMessage` prop is kept (now the `EmptyState` title); default stays `"No orders yet."`.
- Imports add `Skeleton` (from `./ui/skeleton`) and `EmptyState` (from `./empty-state`).

### 3. Loading signals (per surface)

Each list source gains a `loading` boolean that is `true` until the first fetch settles (success or
failure), threaded down to `DataTable`.

- **merchant** (`apps/web-merchant/app/page.tsx`): add `const [loading, setLoading] = useState(true)`;
  `resync` sets `setLoading(false)` in BOTH the `.then` and `.catch` (settled). Pass `loading` to
  `OrdersTable`, which forwards it to `DataTable`. (`OrdersTable` gains a `loading: boolean` prop.)
- **admin** (`apps/web-admin/hooks/use-admin-data.ts` + `app/page.tsx` + `components/admin-orders-table.tsx`):
  add `loading` to the hook state (init `true`), cleared when the first `resync()` settles (`.then`
  and `.catch`); add `loading` to the hook's return type and value. `app/page.tsx` passes it to
  `AdminOrdersTable` (which gains a `loading` prop → `DataTable`). Separately, replace the maps'
  `Loading tenants…` text (the `tenantsLoading && tenants.length === 0` branch) with a row of skeleton
  map-cards: two `<Skeleton className="h-64 w-full rounded-xl" />` placeholders in the existing grid.
- **driver** (`apps/web-driver/hooks/use-nearby-watch.ts` + `app/page.tsx` + `components/nearby-table.tsx`):
  add `loading` to `NearbyState` — `true` when `watching` and the first poll hasn't settled yet,
  `false` when not watching or once a poll settles. `IDLE` has `loading: false`. The hook already
  returns the whole `state`, so the page destructures `const { nearby, loading } = useNearbyWatch(...)`
  and passes `loading` to `NearbyTable` (which gains a `loading` prop → `DataTable`).

### 4. Checkout empty cart (`apps/web-customer/app/checkout/page.tsx`)

Replace `<p className="text-muted-foreground">Your cart is empty.</p>` with:

```tsx
<EmptyState
  title="Your cart is empty"
  description="Add something from the menu to get started."
  action={{ label: "Browse menu", href: "/" }}
/>
```

## Data flow

```
fetch in flight (loading = true) → DataTable renders 5 skeleton rows
settled + data                   → data rows
settled + empty                  → EmptyState (title = emptyMessage)
```

## Error handling

`EmptyState` is purely presentational. The loading flag is set in `finally`-style (both `.then` and
`.catch`) so a failed load still clears `loading` — and merchant/admin show the 4b-ii `ErrorState`
on failure (the empty/loading states never mask a genuine error).

## Testing

- **`EmptyState`** — Vitest (`@flashbite/web-shared`, jsdom): renders the title; renders the
  description; renders an action button that fires `onClick`; renders the action as an `<a>` with the
  `href`.
- **`DataTable`** — new Vitest (`data-table.test.tsx`): with `loading` and empty data, renders
  skeleton placeholders and NOT the empty title; with settled empty data, renders the `EmptyState`
  title and no skeletons; with data, renders the rows. (Provide a minimal `columns` + `data`.)
- **Loading-signal plumbing** (merchant/admin/driver) — integration wiring with no unit harness;
  verified by the app builds + manual (initial load shows skeletons; empty shows `EmptyState`).
- **No new e2e.**

## Affected files

- **Create:** `packages/web-shared/src/components/empty-state.tsx` (+ `empty-state.test.tsx`);
  `packages/web-shared/src/components/data-table.test.tsx`.
- **Modify:** `packages/web-shared/src/components/data-table.tsx` (loading + EmptyState);
  `packages/web-shared/src/index.ts` (export `EmptyState`);
  `apps/web-merchant/app/page.tsx` + `apps/web-merchant/components/orders-table.tsx`;
  `apps/web-admin/hooks/use-admin-data.ts` + `apps/web-admin/app/page.tsx` + `apps/web-admin/components/admin-orders-table.tsx`;
  `apps/web-driver/hooks/use-nearby-watch.ts` + `apps/web-driver/app/page.tsx` + `apps/web-driver/components/nearby-table.tsx`;
  `apps/web-customer/app/checkout/page.tsx`.

## Exit criteria

- Initial loads of the three tables show 5 skeleton rows instead of an instant bare/empty table.
- A settled-empty table shows the shared `EmptyState`; checkout's empty cart shows it too.
- Admin's map area shows skeleton cards while tenants load.
- `EmptyState` + `DataTable` unit tests pass; all 4 apps build clean.
