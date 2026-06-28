# Phase 4b-ii — Error & Not-Found boundaries + `ErrorState` (Design)

**Status:** approved (brainstorm) — pending implementation plan
**Slice of:** Phase 4b (frontend polish). This is **4b-ii** only. Siblings kept separate:
4b-iii loading skeletons + `EmptyState`, 4b-iv action-feedback toasts.

## Goal

Give the four frontends a consistent, on-brand failure experience: one shared presentational
`ErrorState` component, Next.js `error.tsx` / `not-found.tsx` route boundaries in every app, and
conversion of the data-**load** failure swallows (merchant, admin) into retryable `ErrorState`s.

## Decisions (locked from brainstorm)

- **Seam (4b-ii vs 4b-iii):** 4b-ii owns *failures* (errors / not-found). 4b-iii owns *loading
  skeletons + `EmptyState`* (nothing-there-yet). No `EmptyState` and no loading work here.
- **Boundary coverage:** `error.tsx` + `not-found.tsx` in each of the 4 apps' `app/` root, both
  rendering the shared `ErrorState`. **No** `global-error.tsx` (YAGNI — only fires on root-layout
  crashes and would bypass theming/`TenantBranding`).
- **Not-found semantics:** do **not** call `notFound()` anywhere. The customer order page keeps its
  eventual-consistency polling ("Still processing …") unchanged — a brief 404 on a just-placed order
  is correct domain behavior. `not-found.tsx` serves only genuinely unmatched URLs.
- **Failure-path wiring:** convert the data-**load** swallows that hide failures — merchant's
  initial `listOrders()` load and admin's existing inline "Couldn't load" banner — to `ErrorState`.
  Leave action-submission failures (checkout submit, confirm payment, accept/decline) to 4b-iv;
  leave web-driver's small online-status `catch` and the orders page polling alone.
- **Admin treatment:** compact **banner** variant of `ErrorState` (admin errors are often partial —
  a full centered block over a working grid would be too heavy).

## Architecture

### 1. `ErrorState` (`packages/web-shared/src/components/error-state.tsx`, new)

A self-contained, presentational block. It does **not** impose full-screen centering — the consumer
positions it (route boundaries center it; admin renders it as a top banner; merchant renders it in
the content area). Uses existing design tokens and the `Button` primitive; lucide-react is already a
dependency.

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
      ? <Button asChild variant="outline" size="sm"><a href={action.href}>{action.label}</a></Button>
      : <Button variant="outline" size="sm" onClick={action.onClick}>{action.label}</Button>
    : null;

  if (variant === "banner") {
    return (
      <div role="alert" className={cn("flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive", className)}>
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
    <div role="alert" className={cn("flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-10 text-center", className)}>
      <span className="text-muted-foreground" aria-hidden>{icon ?? <AlertTriangle className="h-8 w-8" />}</span>
      <div className="space-y-1">
        <p className="text-base font-bold">{title}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actionEl}
    </div>
  );
}
```

- **`block`** (default): centered column, neutral card border — for the route boundaries and the
  merchant content area.
- **`banner`**: slim row, destructive-tinted (mirrors admin's current alert), action right-aligned —
  for admin's partial-failure notice.

Exported from `packages/web-shared/src/index.ts`.

### 2. Route boundaries (each of the 4 `apps/web-*/app/`)

Identical across apps. Both render inside the existing root layout, so they remain themed and
`TenantBranding` still applies.

`error.tsx` (Client Component — required by Next.js; receives `{ error, reset }`):

```tsx
"use client";
import { useEffect } from "react";
import { ErrorState } from "@flashbite/web-shared";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]); // Next.js convention: surface boundary errors
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

`not-found.tsx` (Server Component is fine — it renders the `"use client"` `ErrorState`):

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

### 3. Failure-path wiring

**merchant** (`apps/web-merchant/app/page.tsx`): the `resync` callback currently does
`listOrders().then(setOrders).catch(() => setOrders([]))` — a failed load silently becomes an empty
dashboard. Add a `loadError` boolean: success sets `orders` + clears the flag; `catch` sets the flag.
When `loadError` is true, render `<ErrorState>` (`block`, action `{label:"Retry", onClick: resync}`)
in the `main` content area in place of `OrdersTable`. `useOrderStream(onEvent, resync)` already calls
`resync` on SSE reconnect, so the error self-clears on recovery.

**admin** (`apps/web-admin/app/page.tsx`): replace the bare inline alert
(`<div role="alert">Couldn't load: …</div>`) with `<ErrorState variant="banner" title="Couldn't load"
description={errors.join(", ")} action={{label:"Retry", onClick: resync}} />`. `errors` and `resync`
already come from `useAdminData()`.

## Data flow

```
render throw in a route segment → Next renders app/error.tsx {error, reset} → ErrorState
   reset() → Next re-renders the segment
unmatched URL                     → Next renders app/not-found.tsx → ErrorState (href "/")
merchant/admin load rejects       → state flag → ErrorState(action onClick = the loader) → retry refetches
```

## Error handling / edge cases

- `error.tsx` logs via `console.error` (the documented Next.js boundary pattern; this is frontend
  boundary code, not a service/worker logger).
- `not-found.tsx` "Back to home" uses a plain `<a href="/">` (web-shared does not depend on
  `next/link`; a full reload from an error page is acceptable).
- Admin partial failures keep the working grid visible; the banner sits above it.
- Boundaries live under the root layout, so a thrown error still renders the themed shell + the
  tenant accent.

## Testing

- **Unit (`ErrorState`)** — Vitest (`@flashbite/web-shared`, jsdom + jest-dom): default title renders
  when none given; `description` renders; `action` with `onClick` renders a button that fires the
  handler on click; `action` with `href` renders an anchor with that `href`; `variant="banner"`
  renders the alert row (e.g. `role="alert"` present and the destructive class applied). Genuine
  assertions.
- **Boundaries + page wiring** — thin Next.js files and integration code with no unit harness
  (merchant/admin have no unit tests). Verified by the 4 app builds (Next validates `error.tsx` /
  `not-found.tsx` shapes) plus manual checks: visit an unmatched path → branded 404; force a render
  throw → error boundary with working "Try again"; stop read-api → merchant shows a retryable error
  instead of a fake-empty table. **No new e2e.**

## Scope / YAGNI

No `global-error.tsx`; no `EmptyState`; no loading skeletons (4b-iii); no toasts (4b-iv); no
`notFound()` calls; no change to the orders page polling or web-driver's online-status catch. Light
theme inherited from 4b-i.

## Affected files

- **Create:** `packages/web-shared/src/components/error-state.tsx` (+ `error-state.test.tsx`);
  `apps/web-{customer,merchant,driver,admin}/app/error.tsx` (×4) and `…/not-found.tsx` (×4).
- **Modify:** `packages/web-shared/src/index.ts` (export `ErrorState`, `ErrorStateAction`);
  `apps/web-merchant/app/page.tsx`; `apps/web-admin/app/page.tsx`.

## Exit criteria

- Every app renders a themed, on-brand page for unmatched routes and for render-time errors (with a
  working retry), via one shared `ErrorState`.
- Merchant no longer shows a fake-empty dashboard on a load failure — it shows a retryable error.
- Admin's inline load-error notice uses the shared `ErrorState` banner.
- `ErrorState` unit tests pass; all 4 apps build clean.
