# Phase 4b-ii — Error & Not-Found boundaries + `ErrorState` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give all four frontends a consistent, on-brand failure experience: one shared `ErrorState` component, `error.tsx`/`not-found.tsx` boundaries per app, and retryable error states for the merchant/admin data-load failures.

**Architecture:** A presentational `ErrorState` (block/banner variants) in `@flashbite/web-shared`, rendered by per-app Next.js route boundaries (`error.tsx`, `not-found.tsx`) inside the existing root layout (so it stays themed + tenant-branded), and wired into the merchant initial load and admin error notice.

**Tech Stack:** Next.js (App Router boundaries), React, Tailwind v4 tokens, lucide-react, shadcn `Button` (Slot `asChild`), Vitest + @testing-library/react (jsdom).

## Global Constraints

- NEVER read, edit, or stage `.env`, `.env.example`, or `apps/write-api/requests.http`.
- `ErrorState` has two variants: `block` (default — centered neutral card; boundaries + merchant) and `banner` (slim destructive-tinted row; admin).
- Boundaries: `error.tsx` + `not-found.tsx` per app only. **No** `global-error.tsx`. **No** `notFound()` calls anywhere. The customer order page polling and web-driver online-status `catch` are NOT touched.
- Out of scope (later slices): `EmptyState`, loading skeletons (4b-iii), toasts (4b-iv).
- Light theme inherited from 4b-i; use existing tokens (`bg-card`, `text-muted-foreground`, `border-destructive/30`, `bg-destructive/5`, `text-destructive`).
- DRY, YAGNI, TDD, frequent commits.

---

## File Structure

- `packages/web-shared/src/components/error-state.tsx` *(new)* — the `ErrorState` component (both variants). One responsibility: render a failure block.
- `packages/web-shared/src/components/error-state.test.tsx` *(new)* — Vitest unit tests.
- `packages/web-shared/src/index.ts` *(modify)* — export `ErrorState` + `ErrorStateAction`.
- `apps/web-{customer,merchant,driver,admin}/app/error.tsx` *(new ×4, identical)* — render-error boundary.
- `apps/web-{customer,merchant,driver,admin}/app/not-found.tsx` *(new ×4, identical)* — unmatched-route boundary.
- `apps/web-merchant/app/page.tsx` *(modify)* — load-failure → retryable `ErrorState`.
- `apps/web-admin/app/page.tsx` *(modify)* — inline alert → `ErrorState` banner.

---

## Task 1: `ErrorState` component (web-shared)

TDD via Vitest. Produces the component every later task consumes.

**Files:**
- Create: `packages/web-shared/src/components/error-state.tsx`
- Create: `packages/web-shared/src/components/error-state.test.tsx`
- Modify: `packages/web-shared/src/index.ts`

**Interfaces:**
- Produces: `export function ErrorState(props): ReactElement` and `export interface ErrorStateAction { label: string; onClick?: () => void; href?: string }`. Props: `{ title?: string (default "Something went wrong"); description?: string; action?: ErrorStateAction; icon?: ReactNode; variant?: "block" | "banner" (default "block"); className?: string }`. Both variants render a container with `role="alert"`.
- Consumes: existing `Button` (`./ui/button`, supports `asChild`), `cn` (`./lib/utils`), `lucide-react`.

- [ ] **Step 1: Write the failing test**

Create `packages/web-shared/src/components/error-state.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorState } from "./error-state";

describe("ErrorState", () => {
  it("renders the default title when none is given", () => {
    render(<ErrorState />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("renders the description", () => {
    render(<ErrorState description="Boom happened" />);
    expect(screen.getByText("Boom happened")).toBeInTheDocument();
  });

  it("renders an action button that fires onClick", () => {
    const onClick = vi.fn();
    render(<ErrorState action={{ label: "Try again", onClick }} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders the action as a link when href is given", () => {
    render(<ErrorState action={{ label: "Home", href: "/" }} />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  });

  it("renders the banner variant as an alert with the destructive style", () => {
    render(<ErrorState variant="banner" title="Couldn't load" description="x, y" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load");
    expect(alert.className).toContain("text-destructive");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
pnpm --filter @flashbite/web-shared exec vitest run src/components/error-state.test.tsx
```
Expected: FAIL — cannot resolve `./error-state` (module does not exist yet).

- [ ] **Step 3: Implement the component**

Create `packages/web-shared/src/components/error-state.tsx`:

```tsx
"use client";
import { AlertTriangle } from "lucide-react";
import type { ReactNode, ReactElement } from "react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export interface ErrorStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

/**
 * Presentational failure block. Does not impose full-screen centering — the consumer positions it
 * (route boundaries center it; admin renders the `banner` variant inline above the grid; merchant
 * renders the `block` variant in the content area).
 */
export function ErrorState({
  title = "Something went wrong",
  description,
  action,
  icon,
  variant = "block",
  className,
}: {
  title?: string;
  description?: string;
  action?: ErrorStateAction;
  icon?: ReactNode;
  variant?: "block" | "banner";
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

  if (variant === "banner") {
    return (
      <div
        role="alert"
        className={cn(
          "flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive",
          className,
        )}
      >
        <span aria-hidden>{icon ?? <AlertTriangle className="h-4 w-4 shrink-0" />}</span>
        <div className="min-w-0">
          <span className="font-semibold">{title}</span>
          {description && <span className="text-destructive/80"> — {description}</span>}
        </div>
        {actionEl && <div className="ml-auto shrink-0">{actionEl}</div>}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-10 text-center",
        className,
      )}
    >
      <span className="text-muted-foreground" aria-hidden>
        {icon ?? <AlertTriangle className="h-8 w-8" />}
      </span>
      <div className="space-y-1">
        <p className="text-base font-bold">{title}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actionEl}
    </div>
  );
}
```

- [ ] **Step 4: Export it from the package**

In `packages/web-shared/src/index.ts`, add after the `AuthGate` / `TenantBranding` exports (near the end, after line 110):

```ts
export { ErrorState, type ErrorStateAction } from "./components/error-state";
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
pnpm --filter @flashbite/web-shared exec vitest run src/components/error-state.test.tsx
```
Expected: PASS (5 cases).

- [ ] **Step 6: Commit**

```bash
git add packages/web-shared/src/components/error-state.tsx packages/web-shared/src/components/error-state.test.tsx packages/web-shared/src/index.ts
git commit -m "feat(web-shared): ErrorState component (block + banner variants)"
```

---

## Task 2: Route boundaries in all 4 apps

No unit harness for Next.js route files — the gate is the 4 app builds (Next validates `error.tsx` must be a Client Component and the file shapes) plus manual verification. Depends on Task 1's `ErrorState` export.

**Files:**
- Create: `apps/web-customer/app/error.tsx`, `apps/web-merchant/app/error.tsx`, `apps/web-driver/app/error.tsx`, `apps/web-admin/app/error.tsx` (identical)
- Create: `apps/web-customer/app/not-found.tsx`, `apps/web-merchant/app/not-found.tsx`, `apps/web-driver/app/not-found.tsx`, `apps/web-admin/app/not-found.tsx` (identical)

**Interfaces:**
- Consumes: `ErrorState` from `@flashbite/web-shared` (Task 1).

- [ ] **Step 1: Create `error.tsx` in all 4 apps**

Create the following file at each of `apps/web-customer/app/error.tsx`, `apps/web-merchant/app/error.tsx`, `apps/web-driver/app/error.tsx`, `apps/web-admin/app/error.tsx` (byte-identical):

```tsx
"use client";
import { useEffect } from "react";
import { ErrorState } from "@flashbite/web-shared";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Next.js convention: surface boundary errors to the console.
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-[70vh] items-center justify-center px-6">
      <ErrorState
        title="Something went wrong"
        description="An unexpected error occurred. Please try again."
        action={{ label: "Try again", onClick: reset }}
        className="max-w-sm"
      />
    </main>
  );
}
```

- [ ] **Step 2: Create `not-found.tsx` in all 4 apps**

Create the following file at each of `apps/web-customer/app/not-found.tsx`, `apps/web-merchant/app/not-found.tsx`, `apps/web-driver/app/not-found.tsx`, `apps/web-admin/app/not-found.tsx` (byte-identical):

```tsx
import { ErrorState } from "@flashbite/web-shared";

export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-6">
      <ErrorState
        title="Page not found"
        description="The page you're looking for doesn't exist."
        action={{ label: "Back to home", href: "/" }}
        className="max-w-sm"
      />
    </main>
  );
}
```

- [ ] **Step 3: Build all 4 apps (the gate)**

Run:
```bash
pnpm --filter web-customer build
pnpm --filter web-merchant build
pnpm --filter web-driver build
pnpm --filter web-admin build
```
Expected: all four exit 0 (`✓ Compiled successfully`). A build failure here means a boundary file is malformed (e.g. `error.tsx` missing `"use client"`).

- [ ] **Step 4: Commit**

```bash
git add apps/web-customer/app/error.tsx apps/web-merchant/app/error.tsx apps/web-driver/app/error.tsx apps/web-admin/app/error.tsx apps/web-customer/app/not-found.tsx apps/web-merchant/app/not-found.tsx apps/web-driver/app/not-found.tsx apps/web-admin/app/not-found.tsx
git commit -m "feat(web): error.tsx + not-found.tsx boundaries in all 4 apps"
```

---

## Task 3: Wire merchant + admin data-load failures to `ErrorState`

Converts the two data-load swallows into retryable error states. No unit harness (merchant/admin have no unit tests); gate is the two app builds + manual. Depends on Task 1.

**Files:**
- Modify: `apps/web-merchant/app/page.tsx`
- Modify: `apps/web-admin/app/page.tsx`

**Interfaces:**
- Consumes: `ErrorState` from `@flashbite/web-shared` (Task 1); merchant's existing `resync`/`listOrders`/`OrdersTable`; admin's `errors`/`resync` from `useAdminData()`.

- [ ] **Step 1: Merchant — add `ErrorState` to imports**

In `apps/web-merchant/app/page.tsx`, add `ErrorState` to the existing `@flashbite/web-shared` import (the block currently importing `listOrders, getOrder, useOrderStream, …`). Change the import line that currently reads:

```tsx
  statusFromEventType, useAuthStore, Input, ORDER_STATUS, AuthGate,
```
to:
```tsx
  statusFromEventType, useAuthStore, Input, ORDER_STATUS, AuthGate, ErrorState,
```

- [ ] **Step 2: Merchant — track load failure in `resync`**

In `apps/web-merchant/app/page.tsx`, add a `loadError` state next to the other `useState` hooks in `MerchantDashboard` (after `const [selected, setSelected] = useState<OrderView | null>(null);`):

```tsx
  const [loadError, setLoadError] = useState(false);
```

Replace the `resync` callback (currently `listOrders().then(setOrders).catch(() => setOrders([]));`) with:

```tsx
  const resync = useCallback(() => {
    listOrders()
      .then((o) => { setOrders(o); setLoadError(false); })
      .catch(() => setLoadError(true));
  }, []);
```

- [ ] **Step 3: Merchant — render `ErrorState` on load failure**

In `apps/web-merchant/app/page.tsx`, replace the single `OrdersTable` line:

```tsx
        <OrdersTable data={visible} globalFilter={filter} dispatches={dispatches} onRowClick={setSelected} />
```
with:

```tsx
        {loadError ? (
          <ErrorState
            title="Couldn't load orders"
            description="We couldn't reach the order service."
            action={{ label: "Retry", onClick: resync }}
            className="mx-auto mt-10 max-w-sm"
          />
        ) : (
          <OrdersTable data={visible} globalFilter={filter} dispatches={dispatches} onRowClick={setSelected} />
        )}
```

- [ ] **Step 4: Admin — add `ErrorState` to imports**

In `apps/web-admin/app/page.tsx`, change the import line:

```tsx
import { AuthGate, Input, useTenants } from "@flashbite/web-shared";
```
to:
```tsx
import { AuthGate, Input, useTenants, ErrorState } from "@flashbite/web-shared";
```

- [ ] **Step 5: Admin — replace the inline alert with the `ErrorState` banner**

In `apps/web-admin/app/page.tsx`, replace the inline error block:

```tsx
        {errors.length > 0 && (
          <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">
            Couldn&apos;t load: {errors.join(", ")}
          </div>
        )}
```
with:

```tsx
        {errors.length > 0 && (
          <ErrorState
            variant="banner"
            title="Couldn't load"
            description={errors.join(", ")}
            action={{ label: "Retry", onClick: resync }}
            className="mb-4"
          />
        )}
```

- [ ] **Step 6: Build merchant + admin (the gate)**

Run:
```bash
pnpm --filter web-merchant build
pnpm --filter web-admin build
```
Expected: both exit 0 (`✓ Compiled successfully`).

- [ ] **Step 7: Commit**

```bash
git add apps/web-merchant/app/page.tsx apps/web-admin/app/page.tsx
git commit -m "feat(web): retryable ErrorState for merchant load + admin error notice"
```

---

## Manual verification (after all tasks)

With the stack running: (a) visit an unmatched path (e.g. `/nope`) in any app → branded "Page not found" with a working "Back to home"; (b) force a render throw in a page → the `error.tsx` boundary shows "Something went wrong" and "Try again" recovers; (c) stop read-api and load the merchant dashboard → a retryable "Couldn't load orders" instead of a fake-empty table; (d) induce an admin load error → the destructive banner appears above a still-working grid.

## Self-Review

- **Spec coverage:** `ErrorState` (block+banner) → Task 1; `error.tsx`/`not-found.tsx` ×4 → Task 2; merchant load + admin banner wiring → Task 3; no `global-error.tsx`/`notFound()`/`EmptyState`/loading/toasts → honored (none added). All spec sections covered.
- **Placeholder scan:** none — every step has complete code/commands.
- **Type consistency:** `ErrorState`/`ErrorStateAction` signatures match across Tasks 1-3; `variant`, `action`, `className` props used in Tasks 2-3 are exactly those defined in Task 1.

## Exit criteria

- Every app renders a themed, on-brand page for unmatched routes and render errors (with working retry), via the shared `ErrorState`.
- Merchant shows a retryable error (not a fake-empty table) on a load failure; admin's load-error notice uses the `ErrorState` banner.
- `ErrorState` unit tests pass; all 4 apps build clean.
