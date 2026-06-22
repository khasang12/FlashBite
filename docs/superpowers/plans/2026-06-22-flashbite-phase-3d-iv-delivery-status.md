# Phase 3d-iv — Delivery status on customer + merchant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show driver-dispatch / delivery progress (`OFFERED → DISPATCHED → PICKED_UP → DELIVERED`, or `FAILED`) on the customer order-tracking page (poll) and the merchant orders table + detail sheet (live SSE), with outward-facing wording.

**Architecture:** read-api gains one tenant-wide merchant dispatch SSE endpoint reusing the existing `DispatchStreamService`. web-shared gains a by-order dispatch read, an outward-facing label, and a `useTenantDispatchStream` hook keyed by orderId. The customer page polls; the merchant streams.

**Tech Stack:** NestJS 10 + RxJS SSE (read-api), Next.js 16 + zustand + `@microsoft/fetch-event-source` (web), Vitest (web-shared), Jest/ts-jest (read-api), Playwright (web e2e).

**Branch:** `phase-3d-iv-delivery-status` (already created, stacked on `phase-3d-ii-driver-job-ui`). Depends on 3d-ii (#28): `DispatchStreamService`, the `dispatch-events` feeder, and the web-shared `DispatchView`/`DISPATCH_STATUS`/`reduceDispatch`/`parseDispatchData` exports. **Land #28 first.**

---

## File Structure

**web-shared** (`packages/web-shared`)
- Modify `src/api/client.ts` — `getOrderDispatch(orderId)`.
- Modify `src/dispatch/labels.ts` — `deliveryStatusLabel`.
- Create `src/dispatch/use-tenant-dispatch-stream.ts` — `reduceDispatchMap` + `useTenantDispatchStream`.
- Modify `src/index.ts` — exports.
- Tests: extend `src/api/client.test.ts`, `src/dispatch/labels.test.ts`; new `src/dispatch/use-tenant-dispatch-stream.test.ts`.

**read-api** (`apps/read-api`)
- Create `src/sse/merchant-dispatch-sse.controller.ts` — `GET /merchant/dispatch/stream`.
- Modify `src/sse/sse.module.ts` — register the controller.
- Test: new `apps/read-api/test/merchant-dispatch-stream.spec.ts`.

**web-customer** (`apps/web-customer`)
- Modify `app/orders/[orderId]/page.tsx` — dispatch poll + Delivery line.

**web-merchant** (`apps/web-merchant`)
- Modify `app/page.tsx` — `useTenantDispatchStream`, pass map down.
- Modify `components/orders-table.tsx` — Delivery column.
- Modify `components/order-detail-sheet.tsx` — Delivery line.

**docs**
- Modify `docs/ARCHITECTURE.md` — note the merchant dispatch SSE + delivery status on customer/merchant.

---

## Task 1: web-shared — getOrderDispatch + deliveryStatusLabel

**Files:**
- Modify: `packages/web-shared/src/api/client.ts`, `packages/web-shared/src/api/client.test.ts`
- Modify: `packages/web-shared/src/dispatch/labels.ts`, `packages/web-shared/src/dispatch/labels.test.ts`
- Modify: `packages/web-shared/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/web-shared/src/dispatch/labels.test.ts`:
```ts
import { deliveryStatusLabel } from "./labels";

describe("deliveryStatusLabel", () => {
  it("maps each dispatch status to outward-facing copy", () => {
    expect(deliveryStatusLabel("OFFERED")).toBe("Finding a driver");
    expect(deliveryStatusLabel("DISPATCHED")).toBe("Driver assigned");
    expect(deliveryStatusLabel("PICKED_UP")).toBe("Out for delivery");
    expect(deliveryStatusLabel("DELIVERED")).toBe("Delivered");
    expect(deliveryStatusLabel("FAILED")).toBe("Delivery unavailable");
  });
  it("passes through an unknown status", () => {
    expect(deliveryStatusLabel("WAT")).toBe("WAT");
  });
});
```

Append to `packages/web-shared/src/api/client.test.ts` — add `getOrderDispatch` to the import-from-`./client` list, and add inside the `describe("api client", ...)` block:
```ts
  it("getOrderDispatch GETs the order dispatch read with Bearer", async () => {
    const view = { tenantId: "berlin", orderId: "o-1", status: "DISPATCHED", driverId: "drv-1", version: 2, updatedAt: "t" };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(view), { status: 200 }));
    const res = await getOrderDispatch("o-1");
    expect(res).toEqual(view);
    expect(lastUrl()).toBe("/api/read/orders/o-1/dispatch");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
  });

  it("getOrderDispatch passes through { status: null }", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: null }), { status: 200 }));
    expect(await getOrderDispatch("o-2")).toEqual({ status: null });
  });
```

- [ ] **Step 2: Run them, confirm they fail**

Run: `pnpm --filter @flashbite/web-shared test -- labels client`
Expected: FAIL — `deliveryStatusLabel` / `getOrderDispatch` not exported.

- [ ] **Step 3: Implement `deliveryStatusLabel`**

Append to `packages/web-shared/src/dispatch/labels.ts`:
```ts
const DELIVERY_LABELS: Record<string, string> = {
  [DISPATCH_STATUS.OFFERED]: "Finding a driver",
  [DISPATCH_STATUS.DISPATCHED]: "Driver assigned",
  [DISPATCH_STATUS.PICKED_UP]: "Out for delivery",
  [DISPATCH_STATUS.DELIVERED]: "Delivered",
  [DISPATCH_STATUS.FAILED]: "Delivery unavailable",
};

/** Customer/merchant-facing label for a delivery (dispatch) status; unknown values pass through.
 *  Distinct from the driver-facing dispatchStatusLabel (which is phrased as driver actions). */
export function deliveryStatusLabel(status: string): string {
  return DELIVERY_LABELS[status] ?? status;
}
```

- [ ] **Step 4: Implement `getOrderDispatch`**

Append to `packages/web-shared/src/api/client.ts` (after the dispatch section; `DispatchView` is already imported on line 1):
```ts
/** GET /orders/:orderId/dispatch — the order's current delivery (dispatch) state, for
 *  customer + merchant views. `status` is null when no dispatch exists yet. */
export async function getOrderDispatch(orderId: string): Promise<DispatchView | { status: null }> {
  const res = await authedFetch(`/api/read/orders/${encodeURIComponent(orderId)}/dispatch`);
  if (!res.ok) throw new Error(`getOrderDispatch failed: ${res.status}`);
  return (await res.json()) as DispatchView | { status: null };
}
```

- [ ] **Step 5: Export from index**

In `packages/web-shared/src/index.ts`: add `getOrderDispatch` to the client re-export block (the `goOnline, goOffline, ...` line), and add `deliveryStatusLabel` to the labels export line:
```ts
export { dispatchStatusLabel, deliveryStatusLabel, DISPATCH_OFFER_TIMEOUT_SECONDS } from "./dispatch/labels";
```

- [ ] **Step 6: Run tests, confirm pass**

Run: `pnpm --filter @flashbite/web-shared test -- labels client`
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add packages/web-shared/src/api/client.ts packages/web-shared/src/api/client.test.ts packages/web-shared/src/dispatch/labels.ts packages/web-shared/src/dispatch/labels.test.ts packages/web-shared/src/index.ts
git commit -m "feat(web-shared): getOrderDispatch + outward-facing deliveryStatusLabel"
```

---

## Task 2: web-shared — useTenantDispatchStream hook

**Files:**
- Create: `packages/web-shared/src/dispatch/use-tenant-dispatch-stream.ts`
- Create: `packages/web-shared/src/dispatch/use-tenant-dispatch-stream.test.ts`
- Modify: `packages/web-shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/web-shared/src/dispatch/use-tenant-dispatch-stream.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { reduceDispatchMap } from "./use-tenant-dispatch-stream";
import type { DispatchView } from "@flashbite/contracts";

const view = (over: Partial<DispatchView> = {}): DispatchView => ({
  tenantId: "berlin", orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 1, updatedAt: "t", ...over,
});

describe("reduceDispatchMap", () => {
  it("adds a new order's view keyed by orderId", () => {
    const out = reduceDispatchMap({}, view());
    expect(out["o-1"].status).toBe("OFFERED");
  });
  it("advances an existing order on a newer version", () => {
    const prev = { "o-1": view({ version: 1 }) };
    const out = reduceDispatchMap(prev, view({ status: "DISPATCHED", driverId: "drv-1", version: 2 }));
    expect(out["o-1"].status).toBe("DISPATCHED");
  });
  it("ignores a stale (older-version) event for an order", () => {
    const prev = { "o-1": view({ status: "DISPATCHED", version: 2 }) };
    const out = reduceDispatchMap(prev, view({ version: 1 }));
    expect(out["o-1"].status).toBe("DISPATCHED");
  });
  it("keeps other orders untouched", () => {
    const prev = { "o-2": view({ orderId: "o-2" }) };
    const out = reduceDispatchMap(prev, view({ orderId: "o-1" }));
    expect(Object.keys(out).sort()).toEqual(["o-1", "o-2"]);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm --filter @flashbite/web-shared test -- use-tenant-dispatch-stream`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

`packages/web-shared/src/dispatch/use-tenant-dispatch-stream.ts`:
```ts
"use client";
import { useEffect, useState } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { DispatchView } from "@flashbite/contracts";
import { useAuthStore } from "../store/auth-store";
import { parseDispatchData, reduceDispatch } from "./use-dispatch-stream";

export type DispatchMap = Record<string, DispatchView>;

/** Merge an incoming dispatch view into the per-order map (version-reconciled). Exported for tests. */
export function reduceDispatchMap(prev: DispatchMap, next: DispatchView): DispatchMap {
  return { ...prev, [next.orderId]: reduceDispatch(prev[next.orderId] ?? null, next) };
}

/**
 * Subscribes to the tenant-wide merchant dispatch SSE stream (every order's delivery state for the
 * merchant's tenant). Fetch-based SSE so the Authorization header is sent. Returns a map of
 * orderId -> latest DispatchView and the connection state.
 */
export function useTenantDispatchStream(): { dispatches: DispatchMap; connected: boolean } {
  const [dispatches, setDispatches] = useState<DispatchMap>({});
  const [connected, setConnected] = useState(false);
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    void fetchEventSource("/api/read/merchant/dispatch/stream", {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      openWhenHidden: true,
      onopen: async (response: Response) => {
        if (response.status === 401) {
          setConnected(false);
          useAuthStore.getState().logout();
          throw new Error("unauthorized");
        }
        setConnected(true);
      },
      onmessage: (msg) => {
        const view = parseDispatchData(msg.data);
        if (view) setDispatches((prev) => reduceDispatchMap(prev, view));
      },
      onerror: () => { setConnected(false); /* let fetchEventSource retry */ },
    }).catch(() => { /* aborted on unmount */ });
    return () => { ctrl.abort(); setConnected(false); };
  }, [token]);

  return { dispatches, connected };
}
```

- [ ] **Step 4: Export from index**

In `packages/web-shared/src/index.ts`, after the `useDispatchStream` export line, add:
```ts
export { useTenantDispatchStream, reduceDispatchMap, type DispatchMap } from "./dispatch/use-tenant-dispatch-stream";
```

- [ ] **Step 5: Run test, confirm pass**

Run: `pnpm --filter @flashbite/web-shared test -- use-tenant-dispatch-stream`
Expected: PASS (4 assertions).

- [ ] **Step 6: Commit**
```bash
git add packages/web-shared/src/dispatch/use-tenant-dispatch-stream.ts packages/web-shared/src/dispatch/use-tenant-dispatch-stream.test.ts packages/web-shared/src/index.ts
git commit -m "feat(web-shared): useTenantDispatchStream (per-order dispatch map over SSE)"
```

---

## Task 3: read-api — merchant dispatch SSE endpoint

**Files:**
- Create: `apps/read-api/src/sse/merchant-dispatch-sse.controller.ts`
- Modify: `apps/read-api/src/sse/sse.module.ts`
- Test: `apps/read-api/test/merchant-dispatch-stream.spec.ts`

- [ ] **Step 1: Write the failing test**

`apps/read-api/test/merchant-dispatch-stream.spec.ts`:
```ts
import { firstValueFrom } from "rxjs";
import { take, toArray } from "rxjs/operators";
import { runWithAuth } from "@flashbite/tenant-context";
import { DispatchStreamService } from "../src/sse/dispatch-stream.service";
import { MerchantDispatchSseController } from "../src/sse/merchant-dispatch-sse.controller";
import type { DispatchView } from "@flashbite/contracts";

const view = (over: Partial<DispatchView> = {}): DispatchView => ({
  tenantId: "berlin", orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 1, updatedAt: "t", ...over,
});

describe("MerchantDispatchSseController", () => {
  it("streams the tenant's dispatch views as { data } for the current tenant", async () => {
    const svc = new DispatchStreamService();
    const ctrl = new MerchantDispatchSseController(svc);
    const collected = runWithAuth({ tenantId: "berlin", role: "merchant", sub: "m-1" }, () =>
      firstValueFrom(ctrl.dispatchStream().pipe(take(2), toArray())),
    );
    svc.publish("berlin", view());
    svc.publish("berlin", view({ status: "DISPATCHED", driverId: "drv-1", version: 2 }));
    const got = await collected;
    expect(got.map((m) => (m.data as DispatchView).status)).toEqual(["OFFERED", "DISPATCHED"]);
  });

  it("does not stream another tenant's dispatch views", async () => {
    const svc = new DispatchStreamService();
    const ctrl = new MerchantDispatchSseController(svc);
    const seen: unknown[] = [];
    runWithAuth({ tenantId: "berlin", role: "merchant", sub: "m-1" }, () => {
      ctrl.dispatchStream().subscribe((m) => seen.push(m));
    });
    svc.publish("tokyo", view({ tenantId: "tokyo" }));
    expect(seen).toEqual([]);
  });
});
```
(`runWithAuth` is exported from `@flashbite/tenant-context` — it sets the AsyncLocalStorage context that `currentTenant()` reads. Confirm the signature by reading `packages/tenant-context/src/auth-context.ts`; it is `runWithAuth(ctx, fn)`.)

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm jest apps/read-api/test/merchant-dispatch-stream.spec.ts`
Expected: FAIL — `MerchantDispatchSseController` not found.

- [ ] **Step 3: Implement the controller**

`apps/read-api/src/sse/merchant-dispatch-sse.controller.ts`:
```ts
import { Controller, Sse, UseGuards } from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { Roles, RolesGuard } from "@flashbite/tenant-context";
import { ROLES } from "@flashbite/contracts";
import { currentTenant } from "../tenant-scope";
import { DispatchStreamService } from "./dispatch-stream.service";

interface MessageEvent {
  data: unknown;
}

@Controller("merchant/dispatch")
@UseGuards(RolesGuard)
export class MerchantDispatchSseController {
  constructor(private readonly stream: DispatchStreamService) {}

  @Sse("stream")
  @Roles(ROLES.MERCHANT)
  dispatchStream(): Observable<MessageEvent> {
    const tenantId = currentTenant();
    // Whole-tenant dispatch updates (no per-driver filter) — the merchant view tracks every order.
    return this.stream.stream(tenantId).pipe(map((view) => ({ data: view })));
  }
}
```
(Confirm `ROLES.MERCHANT` exists in contracts — it does, used by write-api `@Roles`.)

- [ ] **Step 4: Wire the module**

In `apps/read-api/src/sse/sse.module.ts`: import `MerchantDispatchSseController` and add it to `controllers`:
```ts
import { MerchantDispatchSseController } from "./merchant-dispatch-sse.controller";
// ...
  controllers: [MerchantSseController, DriverSseController, MerchantDispatchSseController],
```
(`DispatchStreamService`, `RolesGuard`, `Reflector` are already provided in this module.)

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm jest apps/read-api/test/merchant-dispatch-stream.spec.ts`
Expected: PASS (2 assertions).
Run: `npx tsc --noEmit -p apps/read-api/tsconfig.json`
Expected: EXIT 0.

- [ ] **Step 6: Commit**
```bash
git add apps/read-api/src/sse/merchant-dispatch-sse.controller.ts apps/read-api/src/sse/sse.module.ts apps/read-api/test/merchant-dispatch-stream.spec.ts
git commit -m "feat(read-api): GET /merchant/dispatch/stream (tenant-wide dispatch SSE, merchant-gated)"
```

---

## Task 4: web-customer — delivery line on order tracking

**Files:**
- Modify: `apps/web-customer/app/orders/[orderId]/page.tsx`

- [ ] **Step 1: Add dispatch state + poll**

In `apps/web-customer/app/orders/[orderId]/page.tsx`:

(a) Extend the web-shared import to add `getOrderDispatch`, `deliveryStatusLabel`, and `type DispatchView`:
```ts
  getOrder,
  getOrderDispatch,
  deliveryStatusLabel,
  fetchOrderPayment,
  // ...existing...
  type OrderView,
  type DispatchView,
```

(b) Add state near the other `useState`s in `OrderTrackingContent`:
```ts
  const [dispatch, setDispatch] = useState<DispatchView | null>(null);
```

(c) Inside the poll `tick`, after the payment fetch block (within `if (o) { ... }`), also poll the dispatch once the order is accepted (dispatch only exists post-accept):
```ts
        if (o.status === ORDER_STATUS.ACCEPTED) {
          const d = await getOrderDispatch(orderId).catch(() => null);
          if (active && d && "status" in d && d.status !== null) setDispatch(d as DispatchView);
        }
```
Place this immediately before the `if (TERMINAL.includes(o.status)) return;` line. Note: the order's `TERMINAL` set (ACCEPTED/CANCELLED) currently stops polling on ACCEPTED — change the stop condition so an ACCEPTED order keeps polling until the *delivery* is terminal, so the customer sees delivery progress:

Replace:
```ts
        if (TERMINAL.includes(o.status)) return; // resolved — stop polling
```
with:
```ts
        // Stop once the order is cancelled, or once an accepted order's delivery is terminal.
        const deliveryTerminal = dispatch?.status === DISPATCH_STATUS.DELIVERED || dispatch?.status === DISPATCH_STATUS.FAILED;
        if (o.status === ORDER_STATUS.CANCELLED) return;
        if (o.status === ORDER_STATUS.ACCEPTED && deliveryTerminal) return;
```
and add `DISPATCH_STATUS` to the web-shared import. (The existing `MAX_ATTEMPTS` cap still bounds the loop, so an undelivered order won't poll forever.)

- [ ] **Step 2: Render the Delivery line**

After the Payment line block (the `{paymentStatusLabel(paymentStatus) && ...}` block), add:
```tsx
                {order.status === ORDER_STATUS.ACCEPTED && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Delivery</span>
                    <span className="font-semibold">
                      {dispatch ? deliveryStatusLabel(dispatch.status) : "Preparing…"}
                    </span>
                  </div>
                )}
```

- [ ] **Step 3: Build to verify**

Run: `pnpm --filter web-customer build`
Expected: build succeeds.

- [ ] **Step 4: Commit**
```bash
git add apps/web-customer/app/orders/[orderId]/page.tsx
git commit -m "feat(web-customer): live delivery status on order tracking (poll)"
```

---

## Task 5: web-merchant — delivery column + detail line (live SSE)

**Files:**
- Modify: `apps/web-merchant/app/page.tsx`
- Modify: `apps/web-merchant/components/orders-table.tsx`
- Modify: `apps/web-merchant/components/order-detail-sheet.tsx`

- [ ] **Step 1: Subscribe + thread the dispatch map through the page**

In `apps/web-merchant/app/page.tsx`:

(a) Add to the web-shared import: `useTenantDispatchStream`.

(b) In `MerchantDashboard`, after the `useOrderStream(onEvent, resync);` line:
```ts
  const { dispatches } = useTenantDispatchStream();
```

(c) Pass `dispatches` to the table and the sheet:
```tsx
        <OrdersTable data={visible} globalFilter={filter} dispatches={dispatches} onRowClick={setSelected} />
```
```tsx
      <OrderDetailSheet order={current} dispatch={current ? dispatches[current.orderId] ?? null : null} onClose={() => setSelected(null)} />
```

- [ ] **Step 2: Delivery column in the table**

Rewrite `apps/web-merchant/components/orders-table.tsx` to accept a `dispatches` map and render a Delivery column. The column reads from the map by orderId (TanStack columns are static, so expose the map via a module-level closure set on each render — simplest is to build the columns inside the component with the map in scope):
```tsx
"use client";
import { DataTable, deliveryStatusLabel, type ColumnDef, type OrderView, type DispatchMap } from "@flashbite/web-shared";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const shortId = (id: string) => `#${id.slice(0, 8)}`;
const itemsSummary = (o: OrderView) => (o.items ?? []).map((i) => `${i.sku} ×${i.qty}`).join(", ");
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function buildColumns(dispatches: DispatchMap): ColumnDef<OrderView>[] {
  return [
    { id: "time", accessorKey: "updatedAt", header: "Time", cell: ({ row }) => <span className="text-muted-foreground">{hhmm(row.original.updatedAt)}</span> },
    { id: "order", accessorKey: "orderId", header: "Order", cell: ({ row }) => <span className="font-semibold">{shortId(row.original.orderId)}</span> },
    { id: "customer", accessorKey: "customerId", header: "Customer" },
    { id: "items", header: "Items", cell: ({ row }) => <span className="text-muted-foreground">{itemsSummary(row.original)}</span> },
    { id: "total", accessorKey: "totalAmount", header: "Total", cell: ({ row }) => <span className="font-semibold">{euro(row.original.totalAmount)}</span> },
    { id: "status", accessorKey: "status", header: "Status", cell: ({ row }) => <StatusPillCol status={row.original.status} /> },
    {
      id: "delivery", header: "Delivery", cell: ({ row }) => {
        const d = dispatches[row.original.orderId];
        return d ? <span className="text-sm font-semibold">{deliveryStatusLabel(d.status)}</span> : <span className="text-muted-foreground">—</span>;
      },
    },
  ];
}

import { StatusPill } from "@flashbite/web-shared";
function StatusPillCol({ status }: { status: string }) { return <StatusPill status={status} />; }

export function OrdersTable({
  data, globalFilter, dispatches, onRowClick,
}: {
  data: OrderView[];
  globalFilter: string;
  dispatches: DispatchMap;
  onRowClick: (o: OrderView) => void;
}) {
  return (
    <DataTable
      columns={buildColumns(dispatches)}
      data={data}
      initialSorting={[{ id: "time", desc: true }]}
      globalFilter={globalFilter}
      onRowClick={onRowClick}
    />
  );
}
```
(Keep it simple — if the implementer prefers, import `StatusPill` at the top with the others and drop the `StatusPillCol` wrapper. The only requirement: a "Delivery" column that reads `dispatches[orderId]` and shows `deliveryStatusLabel` or "—".)

- [ ] **Step 3: Delivery line in the detail sheet**

In `apps/web-merchant/components/order-detail-sheet.tsx`:

(a) Add to the web-shared import: `deliveryStatusLabel`, `getOrderDispatch`, `type DispatchView`. Change the component props to accept `dispatch`:
```ts
export function OrderDetailSheet({
  order, dispatch, onClose,
}: {
  order: OrderView | null;
  dispatch: DispatchView | null;
  onClose: () => void;
}) {
```

(b) Add a local fallback fetch (in case the stream hasn't delivered an update for this order yet), mirroring the payment effect:
```ts
  const [dispatchFallback, setDispatchFallback] = useState<DispatchView | null>(null);
  useEffect(() => {
    setDispatchFallback(null);
    if (!order) return;
    let active = true;
    getOrderDispatch(order.orderId)
      .then((d) => { if (active && "status" in d && d.status !== null) setDispatchFallback(d as DispatchView); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [order?.orderId]);
  const delivery = dispatch ?? dispatchFallback;
```

(c) Render a Delivery line after the Total block (before the actions):
```tsx
            {order.status === ORDER_STATUS.ACCEPTED && (
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Delivery</span>
                <span className="font-semibold">{delivery ? deliveryStatusLabel(delivery.status) : "Preparing…"}</span>
              </div>
            )}
```

- [ ] **Step 4: Build to verify**

Run: `pnpm --filter web-merchant build`
Expected: build succeeds.

- [ ] **Step 5: Commit**
```bash
git add apps/web-merchant/app/page.tsx apps/web-merchant/components/orders-table.tsx apps/web-merchant/components/order-detail-sheet.tsx
git commit -m "feat(web-merchant): live delivery column + detail line via tenant dispatch SSE"
```

---

## Task 6: docs + full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Update ARCHITECTURE.md**

In the §2 `read-api` row, append the new stream to its responsibility list (after `GET /driver/dispatch/stream`): `; the tenant-wide merchant dispatch SSE GET /merchant/dispatch/stream`.

Add a bullet after the "Driver job UI (Phase 3d-ii)" bullet in §3:
```
- **Delivery status on customer + merchant (Phase 3d-iv):** the customer tracking page polls
  `GET /orders/:orderId/dispatch` and shows a delivery line (Finding a driver → Driver assigned →
  Out for delivery → Delivered / Delivery unavailable); the merchant orders table + detail sheet show
  the same, live, via a tenant-wide `GET /merchant/dispatch/stream` SSE (the existing
  `DispatchStreamService`, no per-driver filter). Outward-facing labels (`deliveryStatusLabel`); no
  driver identity is surfaced.
```

- [ ] **Step 2: Full verification sweep**
```bash
pnpm --filter @flashbite/web-shared test
npx tsc --noEmit -p apps/read-api/tsconfig.json
pnpm jest apps/read-api/test/merchant-dispatch-stream.spec.ts apps/read-api/test/dispatch-stream.spec.ts packages/contracts
pnpm --filter web-customer build
pnpm --filter web-merchant build
```
Expected: web-shared Vitest all pass; read-api tsc EXIT 0; jest suites pass; both web builds succeed.

- [ ] **Step 3: Commit**
```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(3d-iv): delivery status on customer + merchant in ARCHITECTURE"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** merchant tenant-wide dispatch SSE → Task 3. getOrderDispatch + deliveryStatusLabel → Task 1. useTenantDispatchStream → Task 2. Customer delivery line (poll) → Task 4. Merchant table column + detail line (SSE) → Task 5. No driver identity surfaced (only `status` rendered) → Tasks 4/5. Docs → Task 6. ✓

**Type consistency:** `DispatchView`/`DISPATCH_STATUS`/`reduceDispatch`/`parseDispatchData` are existing web-shared exports (3d-ii); `DispatchMap` is introduced in Task 2 and consumed by Task 5; `deliveryStatusLabel`/`getOrderDispatch` introduced in Task 1 and consumed by Tasks 4/5; `MerchantDispatchSseController` introduced in Task 3 and pathed `/merchant/dispatch/stream` matching the hook in Task 2. `ROLES.MERCHANT` + `runWithAuth` are existing exports (verify `runWithAuth` signature in tenant-context before Task 3).

**Known constraint:** customer polling now continues through an ACCEPTED order until delivery is terminal (Task 4 changes the stop condition) — still bounded by the existing `MAX_ATTEMPTS`. Depends on #28 (3d-ii) being merged first.
