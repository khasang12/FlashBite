# Phase 4b-iv — Action-feedback toasts (Design)

**Status:** approved (brainstorm) — pending implementation plan
**Slice of:** Phase 4b (frontend polish). This is **4b-iv**, the final slice — it closes Phase 4b.
Siblings (done): 4b-i tokens/branding, 4b-ii error boundaries, 4b-iii loading/empty.

## Goal

One consistent feedback channel for user-initiated mutations — success and failure toasts via
`sonner` — replacing the scattered inline error texts and filling the driver dispatch actions'
current no-feedback gap.

## Decisions (locked from brainstorm)

- **Library:** `sonner` (the shadcn/ui standard toast). A themed `<Toaster/>` wrapper + the `toast`
  API are exposed from `@flashbite/web-shared`.
- **Mount:** `<Toaster/>` once per app `layout.tsx` (same pattern as `TenantBranding`), so a toast
  survives a client navigation (e.g. "Order placed" shows on the order page after the redirect).
- **Coverage:** success **and** failure toasts on the explicit user-initiated mutations; the existing
  inline error texts are removed and replaced by failure toasts.
- **Toaster config:** `richColors`, `position="bottom-right"`, `theme="light"` (light-only per 4b-i).
- `toast` is re-exported from `sonner` directly (no wrapper indirection).

## Architecture

### 1. Shared toast surface (`packages/web-shared`)

- Add `sonner` to `packages/web-shared/package.json` dependencies.
- **`packages/web-shared/src/components/toaster.tsx` (new):**

```tsx
"use client";
import { Toaster as SonnerToaster } from "sonner";

/** App-wide toast host. Mounted once per app layout; renders nothing until a toast fires. */
export function Toaster() {
  return <SonnerToaster richColors position="bottom-right" theme="light" />;
}
```

- **`packages/web-shared/src/index.ts`:** `export { Toaster } from "./components/toaster";` and
  `export { toast } from "sonner";`.

### 2. Mount in the 4 app layouts

In each `apps/web-{customer,merchant,driver,admin}/app/layout.tsx`, render `<Toaster />` inside the
`<body>` next to the existing `<TenantBranding />` (import it from `@flashbite/web-shared`).

> Admin has no mutations of its own, but it mounts `<Toaster />` too for consistency (cheap, and keeps
> the layout pattern uniform across all four apps).

### 3. Action wiring (success + failure; inline errors removed)

Each mutation `await`s, then `toast.success(copy)` on resolve / `toast.error(copy)` on reject. Exact copy:

| App | File | Action | success | failure |
|-----|------|--------|---------|---------|
| customer | `app/checkout/page.tsx` | place order | "Order placed" | "Couldn't place your order. Please try again." |
| customer | `app/orders/[orderId]/page.tsx` | confirm payment | "Payment confirmed" | "Couldn't confirm payment. Please try again." |
| merchant | `components/order-detail-sheet.tsx` | accept | "Order accepted" | "Couldn't update the order." |
| merchant | `components/order-detail-sheet.tsx` | decline | "Order declined" | "Couldn't update the order." |
| driver | `app/page.tsx` | accept offer | "Offer accepted" | "Couldn't update the offer." |
| driver | `app/page.tsx` | reject offer | "Offer declined" | "Couldn't update the offer." |
| driver | `app/page.tsx` | pickup | "Marked picked up" | "Couldn't update the job." |
| driver | `app/page.tsx` | deliver | "Marked delivered" | "Couldn't update the job." |
| driver | `components/online-toggle.tsx` | go online/offline | "You're online" / "You're offline" | "Couldn't update your status." |

Per-site changes:

- **checkout** (`submit`): replace `setError("Could not place your order…")` with
  `toast.error("Couldn't place your order. Please try again.")`; add `toast.success("Order placed")`
  on success (before/after `clear()` + `router.push`). Remove the `error` `useState` and the inline
  `{error && <p …>}`. Keep the `inFlight`/`busy` guard.
- **order page** (`onConfirm`): add `toast.success("Payment confirmed")` after `confirmPayment`
  resolves; replace `setConfirmError(…)` with `toast.error("Couldn't confirm payment. Please try again.")`.
  Remove `confirmError` `useState` and its inline render. Keep the `confirming` flag behaviour.
- **merchant `OrderDetailSheet`** (`act`): give `act` a success-message param —
  `const act = async (fn, successMsg: string) => { …; await fn(order.orderId); onClose(); toast.success(successMsg); } catch { toast.error("Couldn't update the order."); }`. Call sites become
  `act(acceptOrder, "Order accepted")` and `act(declineOrder, "Order declined")`. Remove the `error`
  `useState` and its inline render (keep `busy`).
- **driver `page.tsx`** dispatch handlers: replace the fire-and-forget `void acceptDispatch(…)` etc.
  with `acceptDispatch(offer.orderId, driverId).then(() => toast.success("Offer accepted")).catch(() => toast.error("Couldn't update the offer."))` — and likewise reject ("Offer declined"), pickup
  ("Marked picked up", "Couldn't update the job."), deliver ("Marked delivered", same failure copy).
  `reject` keeps its existing `setDismissed(offer.orderId)` call. Import `toast`.
- **`OnlineToggle`** (`toggle`): on success `toast.success(next ? "You're online" : "You're offline")`;
  on failure `toast.error("Couldn't update your status.")`. Remove the `error` `useState` and the
  inline `{error && <span …>}`. Keep `busy`.

## Data flow

```
user clicks action → await mutation
  resolves → toast.success(copy)
  rejects  → toast.error(copy)
<Toaster/> (in the app layout) renders the toast bottom-right
```

## Error handling / edge cases

- Toasts are the single feedback channel; no inline error text remains for these actions.
- Failure copy is generic and user-facing (never leaks raw error/exception text).
- The driver dispatch handlers no longer swallow rejections silently — a failed action now surfaces.

## Out of scope (YAGNI)

Non-mutation reads (covered by 4b-ii `ErrorState` + 4b-iii skeletons); no toasts for background
SSE/projection events; no undo actions; no custom per-toast durations (sonner defaults); no dark theme.

## Testing

- **Unit:** `Toaster` — Vitest smoke test (`@flashbite/web-shared`, jsdom): `<Toaster />` renders
  without throwing and mounts the sonner host (`document.querySelector("[data-sonner-toaster]")` is
  present). (If sonner's host attribute differs in this version, the implementer adjusts the selector
  to the actual rendered host element.)
- **Wiring:** the per-action toast calls are imperative integration with no meaningful unit harness —
  verified by the 4 app builds + manual (trigger each action's success and failure path; confirm a
  toast appears bottom-right and no stale inline error text remains).
- **No new e2e.**

## Affected files

- **Create:** `packages/web-shared/src/components/toaster.tsx` (+ `toaster.test.tsx`).
- **Modify:** `packages/web-shared/package.json` (add `sonner`); `packages/web-shared/src/index.ts`
  (export `Toaster` + `toast`); the 4 `apps/web-*/app/layout.tsx` (mount `<Toaster/>`);
  `apps/web-customer/app/checkout/page.tsx`; `apps/web-customer/app/orders/[orderId]/page.tsx`;
  `apps/web-merchant/components/order-detail-sheet.tsx`; `apps/web-driver/app/page.tsx`;
  `apps/web-driver/components/online-toggle.tsx`.

## Exit criteria

- Every listed action shows a success toast on success and a failure toast on failure.
- No inline error text remains for those actions; the driver dispatch actions are no longer silent.
- `Toaster` smoke test passes; all 4 apps build clean.
- Phase 4b is complete.
