# Phase 4b-iv — Action-feedback toasts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One consistent feedback channel — success/failure toasts via `sonner` — for every user-initiated mutation, replacing the scattered inline error texts and filling the driver actions' no-feedback gap.

**Architecture:** Add `sonner`; expose a themed `<Toaster/>` wrapper + the `toast` API from `@flashbite/web-shared`; mount `<Toaster/>` once per app layout (alongside `TenantBranding`); each mutation `await`s then `toast.success`/`toast.error`. Existing inline error states are removed.

**Tech Stack:** React, Next.js (4 apps), sonner, Tailwind v4 tokens, Vitest + @testing-library/react (jsdom).

## Global Constraints

- NEVER read, edit, or stage `.env`, `.env.example`, or `apps/write-api/requests.http`.
- `<Toaster/>` config is exactly `richColors position="bottom-right" theme="light"`. `toast` is re-exported from `sonner` directly.
- Toast copy is EXACTLY as specified per action (see the table in each task) — user-facing, never raw error text.
- Replace (remove) the existing inline error states for the wired actions; toasts are the single channel.
- Out of scope: non-mutation reads (4b-ii/4b-iii cover those), background/SSE events, undo, custom durations, dark theme.
- DRY, YAGNI, frequent commits.

---

## File Structure

- `packages/web-shared/src/components/toaster.tsx` *(new)* — themed sonner `<Toaster/>` wrapper.
- `packages/web-shared/src/components/toaster.test.tsx` *(new)* — Vitest smoke test.
- `packages/web-shared/package.json` *(modify)* — add `sonner`.
- `packages/web-shared/src/index.ts` *(modify)* — export `Toaster` + `toast`.
- `apps/web-{customer,merchant,driver,admin}/app/layout.tsx` *(modify)* — mount `<Toaster/>`.
- `apps/web-customer/app/checkout/page.tsx` + `apps/web-customer/app/orders/[orderId]/page.tsx` *(modify)*.
- `apps/web-merchant/components/order-detail-sheet.tsx` *(modify)*.
- `apps/web-driver/app/page.tsx` + `apps/web-driver/components/online-toggle.tsx` *(modify)*.

---

## Task 1: Shared `Toaster` + `toast` (web-shared)

TDD via a Vitest smoke test. Produces the toast surface every app consumes.

**Files:**
- Modify: `packages/web-shared/package.json` (add `sonner`)
- Create: `packages/web-shared/src/components/toaster.tsx`
- Create: `packages/web-shared/src/components/toaster.test.tsx`
- Modify: `packages/web-shared/src/index.ts`

**Interfaces:**
- Produces: `export function Toaster(): ReactElement` (themed sonner host) and `export { toast } from "sonner"` (the imperative toast API: `toast.success(msg)`, `toast.error(msg)`).

- [ ] **Step 1: Add the `sonner` dependency**

Run:
```bash
pnpm --filter @flashbite/web-shared add sonner
```
Expected: `sonner` added to `packages/web-shared/package.json` dependencies; lockfile updated.

- [ ] **Step 2: Write the failing test**

Create `packages/web-shared/src/components/toaster.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Toaster } from "./toaster";

describe("Toaster", () => {
  it("mounts the sonner toast host without crashing", () => {
    render(<Toaster />);
    expect(document.querySelector("[data-sonner-toaster]")).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run:
```bash
pnpm --filter @flashbite/web-shared exec vitest run src/components/toaster.test.tsx
```
Expected: FAIL — cannot resolve `./toaster` (module does not exist yet).

- [ ] **Step 4: Create the wrapper**

Create `packages/web-shared/src/components/toaster.tsx`:

```tsx
"use client";
import { Toaster as SonnerToaster } from "sonner";

/** App-wide toast host. Mounted once per app layout; renders nothing until a toast fires. */
export function Toaster() {
  return <SonnerToaster richColors position="bottom-right" theme="light" />;
}
```

- [ ] **Step 5: Export from the package**

In `packages/web-shared/src/index.ts`, add (after the `EmptyState` export line):

```ts
export { Toaster } from "./components/toaster";
export { toast } from "sonner";
```

- [ ] **Step 6: Run the test to verify it passes**

Run:
```bash
pnpm --filter @flashbite/web-shared exec vitest run src/components/toaster.test.tsx
```
Expected: PASS (1 case). If sonner's host element uses a different attribute than `data-sonner-toaster` in this version, inspect the rendered DOM and update the test selector to the actual host element, then re-run.

- [ ] **Step 7: Commit**

```bash
git add packages/web-shared/package.json packages/web-shared/src/components/toaster.tsx packages/web-shared/src/components/toaster.test.tsx packages/web-shared/src/index.ts
git commit -m "feat(web-shared): sonner Toaster + toast export"
```

---

## Task 2: Mount `<Toaster/>` in all 4 layouts + customer toasts

No unit harness for layouts/page wiring; gate is the app builds. Depends on Task 1.

**Files:**
- Modify: `apps/web-customer/app/layout.tsx`, `apps/web-merchant/app/layout.tsx`, `apps/web-driver/app/layout.tsx`, `apps/web-admin/app/layout.tsx`
- Modify: `apps/web-customer/app/checkout/page.tsx`, `apps/web-customer/app/orders/[orderId]/page.tsx`

**Interfaces:**
- Consumes: `Toaster`, `toast` from `@flashbite/web-shared` (Task 1).

- [ ] **Step 1: Mount `<Toaster/>` in all 4 layouts**

In EACH of the 4 `apps/web-*/app/layout.tsx` (all currently `import { TenantBranding } from "@flashbite/web-shared";` and render `<TenantBranding />` then `{children}` in `<body>`):

Change the import:
```tsx
import { TenantBranding, Toaster } from "@flashbite/web-shared";
```
And add `<Toaster />` after `<TenantBranding />`:
```tsx
        <TenantBranding />
        <Toaster />
        {children}
```

- [ ] **Step 2: Checkout — toast on place-order, remove inline error**

In `apps/web-customer/app/checkout/page.tsx`:

Add `toast` to the `@flashbite/web-shared` import (the block importing `useCartStore, placeOrder, Button, Input, Card, CardContent, EmptyState`):
```tsx
  EmptyState,
  toast,
```

Remove the `error` state (delete the line `const [error, setError] = useState<string | null>(null);`).

Replace the `submit` function body's `setError(null)` / `setError(...)` so it toasts. The new `submit`:
```tsx
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const orderId = crypto.randomUUID();
      await placeOrder({
        orderId,
        customerId: name.trim() || "guest",
        items: items.map((l) => ({ sku: l.sku, qty: l.qty, price: l.priceCents })),
        totalAmount: total,
      });
      clear();
      toast.success("Order placed");
      router.push(`/orders/${orderId}`);
    } catch {
      toast.error("Couldn't place your order. Please try again.");
      inFlight.current = false;
      setBusy(false);
    }
  };
```

Remove the inline error block:
```tsx
                {error && (
                  <p className="mt-2 text-sm text-destructive">{error}</p>
                )}
```

- [ ] **Step 3: Order page — toast on confirm-payment, remove inline error**

In `apps/web-customer/app/orders/[orderId]/page.tsx`:

Add `toast` to its `@flashbite/web-shared` import (wherever `confirmPayment` is imported, add `toast` to the same named import).

Remove the `confirmError` state (delete `const [confirmError, setConfirmError] = useState<string | null>(null);` at line 64).

Replace `onConfirm`:
```tsx
  const onConfirm = async () => {
    if (!order) return;
    setConfirming(true);
    try {
      await confirmPayment(order.orderId);
      toast.success("Payment confirmed");
      // saga authorizes shortly; the existing poll surfaces Payment: Authorized
    } catch {
      toast.error("Couldn't confirm payment. Please try again.");
      setConfirming(false);
    }
  };
```

Remove the inline error render (line 177):
```tsx
                    {confirmError && <p className="text-sm text-destructive">{confirmError}</p>}
```

- [ ] **Step 4: Build the affected apps (the gate)**

Run:
```bash
pnpm --filter web-customer build
pnpm --filter web-merchant build
pnpm --filter web-driver build
pnpm --filter web-admin build
```
Expected: all four exit 0 (`✓ Compiled successfully`). (All four build because all four layouts changed; customer also exercises the page wiring.)

- [ ] **Step 5: Commit**

```bash
git add apps/web-customer/app/layout.tsx apps/web-merchant/app/layout.tsx apps/web-driver/app/layout.tsx apps/web-admin/app/layout.tsx apps/web-customer/app/checkout/page.tsx apps/web-customer/app/orders/[orderId]/page.tsx
git commit -m "feat(web): mount Toaster in all layouts + customer action toasts"
```

---

## Task 3: Merchant + driver action toasts

No unit harness; gate is the merchant + driver builds. Depends on Tasks 1 and 2.

**Files:**
- Modify: `apps/web-merchant/components/order-detail-sheet.tsx`
- Modify: `apps/web-driver/app/page.tsx`, `apps/web-driver/components/online-toggle.tsx`

**Interfaces:**
- Consumes: `toast` from `@flashbite/web-shared` (Task 1); `<Toaster/>` already mounted (Task 2).

- [ ] **Step 1: Merchant `OrderDetailSheet` — toasts on accept/decline, remove inline error**

In `apps/web-merchant/components/order-detail-sheet.tsx`:

Add `toast` to the `@flashbite/web-shared` import (the block with `acceptOrder, declineOrder, …`).

Remove the `error` state (delete `const [error, setError] = useState<string | null>(null);`) and the `setError(null);` line inside the first `useEffect` (the one resetting `setBusy(false); setPaymentStatus(null);` on order change — drop only the `setError(null);` statement).

Replace the `act` helper so it takes a success message and toasts:
```tsx
  const act = async (fn: (id: string) => Promise<void>, successMsg: string) => {
    if (!order) return;
    setBusy(true);
    try {
      await fn(order.orderId);
      onClose(); // status flips when the saga's event arrives over SSE
      toast.success(successMsg);
    } catch {
      toast.error("Couldn't update the order.");
    } finally {
      setBusy(false);
    }
  };
```

Update the two call sites:
```tsx
                  <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => act(declineOrder, "Order declined")}>
                    {busy ? "…" : "Decline"}
                  </Button>
                  <Button className="flex-1" disabled={busy} onClick={() => act(acceptOrder, "Order accepted")}>
                    {busy ? "…" : "Accept"}
                  </Button>
```

Remove the inline error render:
```tsx
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
```

- [ ] **Step 2: Driver page — toasts on accept/reject/pickup/deliver**

In `apps/web-driver/app/page.tsx`, add `toast` to the `@flashbite/web-shared` import (the block with `acceptDispatch, rejectDispatch, pickupOrder, deliverOrder, getDriverOnline`):
```tsx
  acceptDispatch, rejectDispatch, pickupOrder, deliverOrder, getDriverOnline, toast,
```

Replace the four fire-and-forget handlers. The `OfferCard` handlers:
```tsx
            onAccept={() => { acceptDispatch(offer.orderId, driverId).then(() => toast.success("Offer accepted")).catch(() => toast.error("Couldn't update the offer.")); }}
            onReject={() => { setDismissed(offer.orderId); rejectDispatch(offer.orderId, driverId).then(() => toast.success("Offer declined")).catch(() => toast.error("Couldn't update the offer.")); }}
```
The `ActiveJobCard` handlers:
```tsx
            onPickup={() => { pickupOrder(job.orderId, driverId).then(() => toast.success("Marked picked up")).catch(() => toast.error("Couldn't update the job.")); }}
            onDeliver={() => { deliverOrder(job.orderId, driverId).then(() => toast.success("Marked delivered")).catch(() => toast.error("Couldn't update the job.")); }}
```

- [ ] **Step 3: `OnlineToggle` — toasts on go online/offline, remove inline error**

Replace the whole `apps/web-driver/components/online-toggle.tsx` with:

```tsx
"use client";
import { useState } from "react";
import { Button, goOnline, goOffline, toast } from "@flashbite/web-shared";

export function OnlineToggle({ driverId, online, onChange }: { driverId: string; online: boolean; onChange: (online: boolean) => void }) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const next = !online;
    try {
      if (next) await goOnline(driverId); else await goOffline(driverId);
      onChange(next);
      toast.success(next ? "You're online" : "You're offline");
    } catch {
      toast.error("Couldn't update your status.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 text-sm font-semibold">
      <span className={online ? "text-primary" : "text-muted-foreground"}>
        {online ? "Online" : "Offline"}
      </span>
      <Button variant={online ? "secondary" : "default"} onClick={toggle} disabled={busy} aria-pressed={online}>
        {online ? "Go offline" : "Go online"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Build merchant + driver (the gate)**

Run:
```bash
pnpm --filter web-merchant build
pnpm --filter web-driver build
```
Expected: both exit 0 (`✓ Compiled successfully`).

- [ ] **Step 5: Commit**

```bash
git add apps/web-merchant/components/order-detail-sheet.tsx apps/web-driver/app/page.tsx apps/web-driver/components/online-toggle.tsx
git commit -m "feat(web): merchant + driver action toasts"
```

---

## Manual verification (after all tasks)

With the stack running, trigger each action's success and failure path and confirm a toast appears bottom-right (green success / red failure) and no stale inline error text remains: place an order; confirm payment; merchant accept/decline; driver accept/reject an offer + pickup/deliver; driver go online/offline (stop read-api to exercise a failure toast).

## Self-Review

- **Spec coverage:** sonner + Toaster + export → Task 1; mount in 4 layouts + customer (place-order, confirm-payment) → Task 2; merchant accept/decline + driver accept/reject/pickup/deliver + online/offline → Task 3. All 9 actions and the inline-error removals covered.
- **Placeholder scan:** none — every step has complete code/commands.
- **Type consistency:** `toast.success`/`toast.error` used everywhere; `act(fn, successMsg: string)` matches both call sites; `Toaster` import/mount uniform across the 4 layouts; copy strings match the spec table verbatim.

## Exit criteria

- Every listed action shows a success toast on success and a failure toast on failure; no inline error text remains for them; driver dispatch actions are no longer silent.
- `Toaster` smoke test passes; all 4 apps build clean.
- Phase 4b is complete.
