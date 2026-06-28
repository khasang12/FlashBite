# Phase 4b-iii — Loading skeletons + `EmptyState` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared `EmptyState` plus real loading skeletons, unified through the shared `DataTable` so the three list tables get a consistent loading → empty → data progression, with admin skeleton map-cards and a checkout empty-cart.

**Architecture:** A presentational `EmptyState` (lighter than `ErrorState` — no card chrome) in `@flashbite/web-shared`; a `loading` prop on the shared `DataTable` that renders 5 skeleton rows during load and the `EmptyState` when settled-and-empty; each list source (merchant page, `useAdminData`, `useNearbyWatch`) gains a `loading` boolean threaded down to `DataTable`.

**Tech Stack:** React, Next.js (4 apps), @tanstack/react-table, Tailwind v4 tokens, lucide-react, shadcn `Skeleton`/`Button`, Vitest + @testing-library/react (jsdom).

## Global Constraints

- NEVER read, edit, or stage `.env`, `.env.example`, or `apps/write-api/requests.http`.
- `EmptyState` is **lighter** than `ErrorState`: no border / `bg-card`; the container provides chrome. Failures stay `ErrorState` (4b-ii); "nothing here yet" is `EmptyState`.
- `DataTable` skeleton row count is **fixed at 5**. `emptyMessage` stays the prop name and becomes the `EmptyState` title; default `"No orders yet."`.
- Each surface's `loading` is `true` until the first fetch **settles** (success OR failure), so a failed load never leaves a permanent skeleton (and 4b-ii's `ErrorState` still shows the failure).
- Out of scope: order-tracking page, customer storefront, driver "offline/waiting" status, admin stat-cards/charts, toasts (4b-iv).
- DRY, YAGNI, TDD, frequent commits.

---

## File Structure

- `packages/web-shared/src/components/empty-state.tsx` *(new)* — presentational empty block.
- `packages/web-shared/src/components/empty-state.test.tsx` *(new)* — Vitest.
- `packages/web-shared/src/components/data-table.tsx` *(modify)* — `loading` prop + `EmptyState`.
- `packages/web-shared/src/components/data-table.test.tsx` *(new)* — Vitest for the 3 states.
- `packages/web-shared/src/index.ts` *(modify)* — export `EmptyState`.
- `apps/web-merchant/app/page.tsx` + `apps/web-merchant/components/orders-table.tsx` *(modify)*.
- `apps/web-admin/hooks/use-admin-data.ts` + `apps/web-admin/app/page.tsx` + `apps/web-admin/components/admin-orders-table.tsx` *(modify)*.
- `apps/web-driver/hooks/use-nearby-watch.ts` + `apps/web-driver/app/page.tsx` + `apps/web-driver/components/nearby-table.tsx` *(modify)*.
- `apps/web-customer/app/checkout/page.tsx` *(modify)*.

---

## Task 1: `EmptyState` component (web-shared)

TDD via Vitest. Produces the component `DataTable` and checkout consume.

**Files:**
- Create: `packages/web-shared/src/components/empty-state.tsx`
- Create: `packages/web-shared/src/components/empty-state.test.tsx`
- Modify: `packages/web-shared/src/index.ts`

**Interfaces:**
- Produces: `export function EmptyState(props): ReactElement`. Props: `{ title: string (required); description?: string; action?: ErrorStateAction; icon?: ReactNode; className?: string }`. Renders a borderless centered block.
- Consumes: `ErrorStateAction` type from `./error-state` (4b-ii); `Button` (`./ui/button`); `cn` (`./lib/utils`); lucide-react.

- [ ] **Step 1: Write the failing test**

Create `packages/web-shared/src/components/empty-state.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders the title", () => {
    render(<EmptyState title="No orders yet" />);
    expect(screen.getByText("No orders yet")).toBeInTheDocument();
  });

  it("renders the description", () => {
    render(<EmptyState title="Empty" description="Add something" />);
    expect(screen.getByText("Add something")).toBeInTheDocument();
  });

  it("renders an action button that fires onClick", () => {
    const onClick = vi.fn();
    render(<EmptyState title="Empty" action={{ label: "Browse", onClick }} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders the action as a link when href is given", () => {
    render(<EmptyState title="Empty" action={{ label: "Home", href: "/" }} />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
pnpm --filter @flashbite/web-shared exec vitest run src/components/empty-state.test.tsx
```
Expected: FAIL — cannot resolve `./empty-state`.

- [ ] **Step 3: Implement the component**

Create `packages/web-shared/src/components/empty-state.tsx`:

```tsx
"use client";
import { Inbox } from "lucide-react";
import type { ReactNode, ReactElement } from "react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import type { ErrorStateAction } from "./error-state";

/**
 * Presentational "nothing here yet" block — the neutral sibling of ErrorState. Lighter on purpose:
 * no border / card background, so it sits cleanly inside a table cell or an existing card. The
 * consumer provides any surrounding chrome.
 */
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
      ? (
        <Button asChild variant="outline" size="sm">
          <a href={action.href}>{action.label}</a>
        </Button>
      )
      : (
        <Button variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )
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

- [ ] **Step 4: Export it from the package**

In `packages/web-shared/src/index.ts`, add after the `ErrorState` export line (`export { ErrorState, type ErrorStateAction } from "./components/error-state";`):

```ts
export { EmptyState } from "./components/empty-state";
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
pnpm --filter @flashbite/web-shared exec vitest run src/components/empty-state.test.tsx
```
Expected: PASS (4 cases).

- [ ] **Step 6: Commit**

```bash
git add packages/web-shared/src/components/empty-state.tsx packages/web-shared/src/components/empty-state.test.tsx packages/web-shared/src/index.ts
git commit -m "feat(web-shared): EmptyState component (neutral sibling of ErrorState)"
```

---

## Task 2: `DataTable` loading + empty (web-shared)

TDD via Vitest. Depends on Task 1's `EmptyState`.

**Files:**
- Modify: `packages/web-shared/src/components/data-table.tsx`
- Create: `packages/web-shared/src/components/data-table.test.tsx`

**Interfaces:**
- Consumes: `EmptyState` (Task 1); existing `Skeleton` (`./ui/skeleton`, renders `<div data-slot="skeleton">`).
- Produces: `DataTableProps` gains `loading?: boolean`. When `loading`, the body is 5 skeleton rows; when settled & empty, an `EmptyState` with `title={emptyMessage}`; else data rows.

- [ ] **Step 1: Write the failing test**

Create `packages/web-shared/src/components/data-table.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "./data-table";

interface Row { id: string; name: string }
const columns: ColumnDef<Row>[] = [
  { id: "id", accessorKey: "id", header: "ID", cell: ({ row }) => <span>{row.original.id}</span> },
  { id: "name", accessorKey: "name", header: "Name", cell: ({ row }) => <span>{row.original.name}</span> },
];

describe("DataTable", () => {
  it("renders 5 skeleton rows while loading (no empty message, no data)", () => {
    const { container } = render(<DataTable columns={columns} data={[]} loading emptyMessage="Nothing here" />);
    expect(screen.queryByText("Nothing here")).toBeNull();
    // 5 rows x 2 columns = 10 skeleton placeholders
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(10);
  });

  it("renders the EmptyState when settled and empty", () => {
    const { container } = render(<DataTable columns={columns} data={[]} emptyMessage="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  });

  it("renders rows when there is data", () => {
    render(<DataTable columns={columns} data={[{ id: "r1", name: "Alice" }]} emptyMessage="Nothing here" />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Nothing here")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
pnpm --filter @flashbite/web-shared exec vitest run src/components/data-table.test.tsx
```
Expected: FAIL — `loading` does nothing yet, so the first test finds 0 skeletons (expected 10) and the empty cell still shows plain "Nothing here" text (second test may pass coincidentally, first fails).

- [ ] **Step 3: Add the imports**

In `packages/web-shared/src/components/data-table.tsx`, add to the imports (after the `./ui/button` import on line 24):

```tsx
import { Skeleton } from "./ui/skeleton";
import { EmptyState } from "./empty-state";
```

- [ ] **Step 4: Add the `loading` prop**

In `DataTableProps` (interface, after `emptyMessage?: string;`):

```tsx
  loading?: boolean;
```

In the `DataTable` destructured params (after `emptyMessage = "No orders yet.",`):

```tsx
  loading = false,
```

- [ ] **Step 5: Make the `<TableBody>` three-way**

Replace the entire `<TableBody>...</TableBody>` block (currently the `rows.length === 0 ? (...) : (...)` ternary) with:

```tsx
      <TableBody>
        {loading ? (
          Array.from({ length: 5 }).map((_, r) => (
            <TableRow key={`sk-${r}`}>
              {columns.map((_c, c) => (
                <TableCell key={`sk-${r}-${c}`}>
                  <Skeleton className="h-4 w-2/3" />
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : table.getRowModel().rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="p-0">
              <EmptyState title={emptyMessage} />
            </TableCell>
          </TableRow>
        ) : (
          table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              onClick={() => onRowClick?.(row.original)}
              className={onRowClick ? "cursor-pointer" : ""}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
```

- [ ] **Step 6: Run the test to verify it passes**

Run:
```bash
pnpm --filter @flashbite/web-shared exec vitest run src/components/data-table.test.tsx
```
Expected: PASS (3 cases).

- [ ] **Step 7: Commit**

```bash
git add packages/web-shared/src/components/data-table.tsx packages/web-shared/src/components/data-table.test.tsx
git commit -m "feat(web-shared): DataTable loading skeletons + EmptyState"
```

---

## Task 3: Wire loading signals into the apps + checkout empty-cart

No unit harness for the app wiring (merchant/admin/driver have no unit tests); gate is the 4 app builds + manual. Depends on Tasks 1 and 2.

**Files:**
- Modify: `apps/web-merchant/app/page.tsx`, `apps/web-merchant/components/orders-table.tsx`
- Modify: `apps/web-admin/hooks/use-admin-data.ts`, `apps/web-admin/app/page.tsx`, `apps/web-admin/components/admin-orders-table.tsx`
- Modify: `apps/web-driver/hooks/use-nearby-watch.ts`, `apps/web-driver/app/page.tsx`, `apps/web-driver/components/nearby-table.tsx`
- Modify: `apps/web-customer/app/checkout/page.tsx`

**Interfaces:**
- Consumes: `DataTable` `loading` prop (Task 2); `EmptyState` (Task 1).

- [ ] **Step 1: Merchant — add a `loading` state and thread it through**

In `apps/web-merchant/app/page.tsx`, add a `loading` state after `const [loadError, setLoadError] = useState(false);`:

```tsx
  const [loading, setLoading] = useState(true);
```

Replace the `resync` callback with one that clears `loading` once settled:

```tsx
  const resync = useCallback(() => {
    listOrders()
      .then((o) => { setOrders(o); setLoadError(false); setLoading(false); })
      .catch(() => { setLoadError(true); setLoading(false); });
  }, []);
```

Pass `loading` to `OrdersTable` (the existing `<OrdersTable ... />` in the `loadError ? ... : (...)` branch):

```tsx
          <OrdersTable data={visible} globalFilter={filter} dispatches={dispatches} onRowClick={setSelected} loading={loading} />
```

- [ ] **Step 2: Merchant — add the `loading` prop to `OrdersTable`**

In `apps/web-merchant/components/orders-table.tsx`, change the `OrdersTable` signature and the `DataTable` call:

```tsx
export function OrdersTable({
  data, globalFilter, dispatches, onRowClick, loading,
}: {
  data: OrderView[];
  globalFilter: string;
  dispatches: DispatchMap;
  onRowClick: (o: OrderView) => void;
  loading: boolean;
}) {
  return (
    <DataTable
      columns={buildColumns(dispatches)}
      data={data}
      initialSorting={[{ id: "time", desc: true }]}
      globalFilter={globalFilter}
      onRowClick={onRowClick}
      loading={loading}
    />
  );
}
```

- [ ] **Step 3: Admin — add `loading` to `useAdminData`**

In `apps/web-admin/hooks/use-admin-data.ts`:

Add `loading: boolean;` to the `AdminData` interface (after `resync: () => void;`):

```tsx
  loading: boolean;
```

Add the state (after `const [errors, setErrors] = useState<string[]>([]);`):

```tsx
  const [loading, setLoading] = useState(true);
```

Replace the `resync` callback so the first settle clears `loading`:

```tsx
  const resync = useCallback(() => {
    getAdminOrders()
      .then((rows) => { if (mountedRef.current) setOrders(rows); })
      .catch(() => noteError("orders: admin"))
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [noteError]);
```

Add `loading` to the returned object (the final `return { ... }`):

```tsx
  return { orders, driversByTenant, errors, handleEvent, resync, loading };
```

- [ ] **Step 4: Admin — pass `loading` to the table and swap the maps loading text for skeletons**

In `apps/web-admin/app/page.tsx`:

Add `Skeleton` to the `@flashbite/web-shared` import (the line `import { AuthGate, Input, useTenants, ErrorState } from "@flashbite/web-shared";`):

```tsx
import { AuthGate, Input, useTenants, ErrorState, Skeleton } from "@flashbite/web-shared";
```

Destructure `loading` from the hook (the line `const { orders, driversByTenant, errors, handleEvent, resync } = useAdminData();`):

```tsx
  const { orders, driversByTenant, errors, handleEvent, resync, loading } = useAdminData();
```

Pass it to `AdminOrdersTable` (the `<AdminOrdersTable data={orders} globalFilter={filter} />`):

```tsx
          <AdminOrdersTable data={orders} globalFilter={filter} loading={loading} />
```

Replace the maps loading branch — change:

```tsx
          {tenantsLoading && tenants.length === 0 ? (
            <div className="text-sm text-muted-foreground">Loading tenants…</div>
          ) : (
```
to:
```tsx
          {tenantsLoading && tenants.length === 0 ? (
            <>
              <Skeleton className="h-64 w-full rounded-xl" />
              <Skeleton className="h-64 w-full rounded-xl" />
            </>
          ) : (
```

- [ ] **Step 5: Admin — add the `loading` prop to `AdminOrdersTable`**

In `apps/web-admin/components/admin-orders-table.tsx`, change the signature + `DataTable` call:

```tsx
export function AdminOrdersTable({ data, globalFilter, loading }: { data: OrderView[]; globalFilter: string; loading: boolean }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      initialSorting={[{ id: "time", desc: true }]}
      globalFilter={globalFilter}
      loading={loading}
      emptyMessage="No orders yet."
    />
  );
}
```

- [ ] **Step 6: Driver — add `loading` to `useNearbyWatch`**

In `apps/web-driver/hooks/use-nearby-watch.ts`:

Add `loading: boolean;` to `NearbyState` (after `reconnecting: boolean;`):

```tsx
  loading: boolean;
```

Change `IDLE`:

```tsx
const IDLE: NearbyState = { nearby: [], reconnecting: false, loading: false };
```

Replace the effect body so loading is true from entering `watching` until the first poll settles. Replace the whole `useEffect(() => { ... }, [center.lng, center.lat, watching]);` with:

```tsx
  useEffect(() => {
    if (!watching) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(IDLE);
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async (): Promise<void> => {
      let fetched: NearbyDriver[] | null = null;
      try {
        fetched = await getNearbyDrivers(center.lng, center.lat, RADIUS_KM);
      } catch {
        fetched = null; // transient — keep last results, flag reconnecting
      }

      if (!active) return;
      setState((prev) => ({
        nearby: fetched ?? prev.nearby,
        reconnecting: fetched === null,
        loading: false,
      }));
      timer = setTimeout(() => void tick(), TICK_MS);
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((prev) => ({ ...prev, loading: prev.nearby.length === 0 })); // entering watch: skeleton until first poll
    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [center.lng, center.lat, watching]);
```

- [ ] **Step 7: Driver — consume `loading` in the page and `NearbyTable`**

In `apps/web-driver/app/page.tsx`, destructure `loading` (the line `const { nearby } = useNearbyWatch(center ?? { lng: 0, lat: 0 }, online && center !== null);`):

```tsx
  const { nearby, loading } = useNearbyWatch(center ?? { lng: 0, lat: 0 }, online && center !== null);
```

Pass it to `NearbyTable` (the `<NearbyTable data={others} />`):

```tsx
              <NearbyTable data={others} loading={loading} />
```

In `apps/web-driver/components/nearby-table.tsx`, change the signature + `DataTable` call:

```tsx
export function NearbyTable({ data, loading }: { data: NearbyDriver[]; loading: boolean }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      initialSorting={[{ id: "distance", desc: false }]}
      loading={loading}
      emptyMessage="No nearby drivers."
    />
  );
}
```

- [ ] **Step 8: Checkout — empty-cart `EmptyState`**

In `apps/web-customer/app/checkout/page.tsx`:

Add `EmptyState` to the `@flashbite/web-shared` import (the block importing `useCartStore, placeOrder, Button, Input, Card, CardContent`):

```tsx
import {
  useCartStore,
  placeOrder,
  Button,
  Input,
  Card,
  CardContent,
  EmptyState,
} from "@flashbite/web-shared";
```

Replace the empty-cart line:

```tsx
              <p className="text-muted-foreground">Your cart is empty.</p>
```
with:
```tsx
              <EmptyState
                title="Your cart is empty"
                description="Add something from the menu to get started."
                action={{ label: "Browse menu", href: "/" }}
              />
```

- [ ] **Step 9: Build all 4 apps (the gate)**

Run:
```bash
pnpm --filter web-customer build
pnpm --filter web-merchant build
pnpm --filter web-driver build
pnpm --filter web-admin build
```
Expected: all four exit 0 (`✓ Compiled successfully`). (Watch for the eslint `react-hooks/set-state-in-effect` rule in the driver hook — the two `eslint-disable-next-line` comments above suppress it.)

- [ ] **Step 10: Commit**

```bash
git add apps/web-merchant/app/page.tsx apps/web-merchant/components/orders-table.tsx apps/web-admin/hooks/use-admin-data.ts apps/web-admin/app/page.tsx apps/web-admin/components/admin-orders-table.tsx apps/web-driver/hooks/use-nearby-watch.ts apps/web-driver/app/page.tsx apps/web-driver/components/nearby-table.tsx apps/web-customer/app/checkout/page.tsx
git commit -m "feat(web): loading skeletons + EmptyState across merchant/admin/driver/checkout"
```

---

## Manual verification (after all tasks)

With the stack running: (a) load the merchant dashboard → table shows 5 skeleton rows, then orders (or `EmptyState` "No orders yet." if none); (b) admin → orders table skeletons + skeleton map-cards until tenants load; (c) driver go online → nearby table shows skeletons until the first poll, then drivers or "No nearby drivers."; (d) checkout with an empty cart → the `EmptyState` with a working "Browse menu" link.

## Self-Review

- **Spec coverage:** `EmptyState` → Task 1; `DataTable` loading/empty → Task 2; merchant/admin/driver loading signals + admin map skeletons + checkout empty-cart → Task 3. All spec sections covered.
- **Placeholder scan:** none — every step has complete code/commands.
- **Type consistency:** `loading` is `boolean` everywhere; `OrdersTable`/`AdminOrdersTable`/`NearbyTable` all gain `loading: boolean`; `DataTable` `loading?: boolean`; `AdminData.loading`/`NearbyState.loading` are `boolean`; `EmptyState` props match Task 1.

## Exit criteria

- The three tables show 5 skeleton rows on initial load, the shared `EmptyState` when settled-empty, rows otherwise.
- Admin map area shows skeleton cards while tenants load; checkout empty cart shows `EmptyState` with a working link.
- `EmptyState` + `DataTable` unit tests pass; all 4 apps build clean.
