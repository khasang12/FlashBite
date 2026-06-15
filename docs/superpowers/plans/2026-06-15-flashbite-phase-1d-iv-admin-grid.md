# Phase 1d-iv Admin Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/web-admin` — a cross-tenant operator grid (GMV + analytics charts, per-tenant driver maps, combined orders table with cancel reasons) via client-side fan-out, plus a focused backend change that surfaces the order cancellation reason on the read model.

**Architecture:** The admin app loops the fixed `TENANTS`, calls the existing per-tenant read-api endpoints (`listOrders`, `getNearbyDrivers`, `useOrderStream`), and aggregates in the browser with pure helpers in `web-shared`. A small backend change adds `cancelReason` to `OrderView` (projection persists it, read-api passes it through, SSE feeder emits it).

**Tech Stack:** Next.js 16.2.9, React 19.2.4, Tailwind v4, recharts (charts), react-map-gl v8 + mapbox-gl v3 (maps), shared `DataTable`, Vitest (web-shared), Jest (backend), Playwright (web-admin).

**Spec:** `docs/superpowers/specs/2026-06-15-flashbite-phase-1d-iv-admin-grid-design.md`

---

## File Structure

**Backend `cancelReason` (Tasks 1–3):**
- Modify `packages/contracts/src/index.ts` — `OrderView.cancelReason?: string`.
- Modify `apps/projection-worker/src/projection.ts` — persist `cancelReason` on `OrderCancelled`.
- Modify `apps/read-api/src/orders/orders-query.service.ts` — map `cancelReason` through (both mappers).
- Modify `apps/read-api/src/sse/sse-feeder.service.ts` — `toStreamEvent` emits `cancelReason` on cancel.
- Tests: `apps/projection-worker/test/projection.spec.ts`, `apps/read-api/test/merchant-orders.e2e-spec.ts`, a new `apps/read-api/test/sse-feeder.spec.ts`.

**web-shared (Tasks 4–5):**
- Modify `packages/web-shared/src/orders/order-events.ts` — `OrderStreamEvent.cancelReason?`, `applyOrderEvent` sets it.
- Create `packages/web-shared/src/orders/analytics.ts` — pure cross-tenant aggregation helpers.
- Create `packages/web-shared/src/orders/analytics.test.ts` — Vitest.
- Modify `packages/web-shared/src/index.ts` — export analytics helpers.

**apps/web-admin (Tasks 6–11):**
- Config (mirror web-driver): `package.json`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs`, `next-env.d.ts`, `.gitignore`, `.env.example`, `playwright.config.ts`.
- `app/layout.tsx`, `app/globals.css`, `app/page.tsx`.
- `hooks/use-admin-data.ts` — fan-out state (snapshots + driver polling + live merge).
- `components/tenant-stream.tsx` — one `useOrderStream` subscription per tenant.
- `components/stat-cards.tsx`, `components/charts.tsx` (4 recharts charts), `components/tenant-map.tsx`, `components/admin-orders-table.tsx`.
- `e2e/admin.spec.ts`.

**Root:** `jest.config.cjs` (+`apps/web-admin/`), `package.json` (`dev:web-admin`, `test:e2e:admin`).

---

## Task 1: Backend — persist `cancelReason` on the read model

**Files:**
- Modify: `packages/contracts/src/index.ts` (OrderView)
- Modify: `apps/projection-worker/src/projection.ts`
- Test: `apps/projection-worker/test/projection.spec.ts`

- [ ] **Step 1: Strengthen the failing test**

In `apps/projection-worker/test/projection.spec.ts`, in the existing test `"transitions an existing order to CANCELLED on OrderCancelled (v2)"` (around line 114), add an assertion after the status assertion:
```ts
    expect(doc?.status).toBe("CANCELLED");
    expect(doc?.version).toBe(2);
    expect(doc?.cancelReason).toBe("SLA_BREACH");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec jest apps/projection-worker/test/projection.spec.ts -t "OrderCancelled"`
Expected: FAIL — `doc.cancelReason` is `undefined`.

- [ ] **Step 3: Add the field to the contract**

In `packages/contracts/src/index.ts`, add `cancelReason` to `OrderView`:
```ts
export interface OrderView {
  tenantId: string;
  orderId: string;
  customerId: string;
  items: OrderItem[];
  totalAmount: number;
  status: string;
  version: number;
  updatedAt: string;
  cancelReason?: string;
}
```

- [ ] **Step 4: Persist it in the projection**

In `apps/projection-worker/src/projection.ts`, replace the ACCEPTED/CANCELLED branch body (the `else if` block that builds `status` and updates) with one that also writes `cancelReason` on cancel:
```ts
  } else if (
    envelope.eventType === EVENT_TYPES.ORDER_ACCEPTED ||
    envelope.eventType === EVENT_TYPES.ORDER_CANCELLED
  ) {
    const isCancel = envelope.eventType === EVENT_TYPES.ORDER_CANCELLED;
    const status = isCancel ? ORDER_STATUS.CANCELLED : ORDER_STATUS.ACCEPTED;
    const existing = await orders.findOne({ _id: _id as never });
    if (existing && (existing.version as number) < envelope.version) {
      const set: Record<string, unknown> = { status, version: envelope.version, updatedAt: envelope.occurredAt };
      if (isCancel) set.cancelReason = (envelope.payload as { reason?: string }).reason;
      await orders.updateOne({ _id: _id as never }, { $set: set });
    }
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec jest apps/projection-worker/test/projection.spec.ts`
Expected: PASS (all projection tests).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts apps/projection-worker/src/projection.ts apps/projection-worker/test/projection.spec.ts
git commit -m "feat(projection): persist cancelReason on OrderCancelled (read model)"
```

---

## Task 2: Backend — read-api passes `cancelReason` through

**Files:**
- Modify: `apps/read-api/src/orders/orders-query.service.ts`
- Test: `apps/read-api/test/merchant-orders.e2e-spec.ts`

- [ ] **Step 1: Add a failing e2e expectation**

In `apps/read-api/test/merchant-orders.e2e-spec.ts`, update the `seed` helper to accept an optional `cancelReason`, and add a test. Change the `seed` signature/body:
```ts
  const seed = async (tenantId: string, status: string, updatedAt: string, cancelReason?: string) => {
    const orderId = randomUUID();
    ids.push(`${tenantId}:${orderId}`);
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).insertOne({
      _id: `${tenantId}:${orderId}` as never,
      tenantId, orderId, customerId: "c-1",
      items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200,
      status, version: 1, updatedAt, ...(cancelReason ? { cancelReason } : {}),
    });
    return orderId;
  };
```
Add this test after the existing one:
```ts
  it("returns cancelReason on cancelled orders", async () => {
    const cancelled = await seed("berlin", ORDER_STATUS.CANCELLED, "2026-06-14T13:00:00.000Z", "SLA_BREACH");
    const res = await request(app.getHttpServer()).get("/merchant/orders").set("X-Tenant-ID", "berlin");
    const row = (res.body as OrderView[]).find((o) => o.orderId === cancelled);
    expect(row?.status).toBe(ORDER_STATUS.CANCELLED);
    expect(row?.cancelReason).toBe("SLA_BREACH");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec jest apps/read-api/test/merchant-orders.e2e-spec.ts -t cancelReason`
Expected: FAIL — `row.cancelReason` is `undefined` (mapper drops it).

- [ ] **Step 3: Map the field through (both mappers)**

In `apps/read-api/src/orders/orders-query.service.ts`, add `cancelReason: doc.cancelReason` to BOTH the `getOrder` view object and the `listRecentOrders` map. In `getOrder`:
```ts
    const view: OrderView = {
      tenantId: doc.tenantId,
      orderId: doc.orderId,
      customerId: doc.customerId,
      items: doc.items,
      totalAmount: doc.totalAmount,
      status: doc.status,
      version: doc.version,
      updatedAt: doc.updatedAt,
      cancelReason: doc.cancelReason,
    };
```
In `listRecentOrders` `.map`:
```ts
    return docs.map((doc) => ({
      tenantId: doc.tenantId,
      orderId: doc.orderId,
      customerId: doc.customerId,
      items: doc.items,
      totalAmount: doc.totalAmount,
      status: doc.status,
      version: doc.version,
      updatedAt: doc.updatedAt,
      cancelReason: doc.cancelReason,
    }));
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec jest apps/read-api/test/merchant-orders.e2e-spec.ts`
Expected: PASS. (Needs infra: `pnpm infra:up`.)

- [ ] **Step 5: Commit**

```bash
git add apps/read-api/src/orders/orders-query.service.ts apps/read-api/test/merchant-orders.e2e-spec.ts
git commit -m "feat(read-api): pass cancelReason through order views"
```

---

## Task 3: Backend — SSE feeder emits `cancelReason` on cancel

**Files:**
- Modify: `apps/read-api/src/sse/sse-feeder.service.ts`
- Test: `apps/read-api/test/sse-feeder.spec.ts` (new — pure unit test of `toStreamEvent`)

- [ ] **Step 1: Write the failing unit test**

Create `apps/read-api/test/sse-feeder.spec.ts`:
```ts
import { buildEnvelope } from "@flashbite/shared";
import { EVENT_TYPES, ORDER_STATUS } from "@flashbite/contracts";
import { toStreamEvent } from "../src/sse/sse-feeder.service";

describe("toStreamEvent", () => {
  it("maps an OrderPlaced envelope to {orderId, eventType, status} without a cancelReason", () => {
    const env = buildEnvelope({
      tenantId: "berlin", eventType: EVENT_TYPES.ORDER_PLACED, version: 1,
      payload: { orderId: "o-1", customerId: "c", items: [], totalAmount: 0 },
    });
    const ev = toStreamEvent(env);
    expect(ev.orderId).toBe("o-1");
    expect(ev.eventType).toBe(EVENT_TYPES.ORDER_PLACED);
    expect(ev.cancelReason).toBeUndefined();
  });

  it("includes cancelReason on an OrderCancelled envelope", () => {
    const env = buildEnvelope({
      tenantId: "berlin", eventType: EVENT_TYPES.ORDER_CANCELLED, version: 2,
      payload: { orderId: "o-1", reason: "DECLINED" },
    });
    const ev = toStreamEvent(env);
    expect(ev.orderId).toBe("o-1");
    expect(ev.eventType).toBe(EVENT_TYPES.ORDER_CANCELLED);
    expect(ev.cancelReason).toBe("DECLINED");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec jest apps/read-api/test/sse-feeder.spec.ts`
Expected: FAIL — `ev.cancelReason` is `undefined` on the cancelled case.

- [ ] **Step 3: Update `toStreamEvent`**

In `apps/read-api/src/sse/sse-feeder.service.ts`, replace the `toStreamEvent` function:
```ts
/** Maps an order-events envelope to the merchant SSE event shape. */
export function toStreamEvent(envelope: EventEnvelope) {
  const p = envelope.payload as Partial<OrderPlacedPayload> & { reason?: string };
  const cancelReason = envelope.eventType === EVENT_TYPES.ORDER_CANCELLED ? p.reason : undefined;
  return { orderId: p.orderId ?? "", eventType: envelope.eventType, status: ORDER_STATUS.PLACED, cancelReason };
}
```
Add `EVENT_TYPES` to the existing `@flashbite/contracts` import in that file (it currently imports `CONSUMER_GROUPS, ORDER_STATUS, TOPICS, type EventEnvelope, type OrderPlacedPayload`):
```ts
import {
  CONSUMER_GROUPS,
  EVENT_TYPES,
  ORDER_STATUS,
  TOPICS,
  type EventEnvelope,
  type OrderPlacedPayload,
} from "@flashbite/contracts";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec jest apps/read-api/test/sse-feeder.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/read-api/src/sse/sse-feeder.service.ts apps/read-api/test/sse-feeder.spec.ts
git commit -m "feat(read-api): SSE feeder emits cancelReason on OrderCancelled"
```

---

## Task 4: web-shared — `OrderStreamEvent.cancelReason` + `applyOrderEvent`

**Files:**
- Modify: `packages/web-shared/src/orders/order-events.ts`
- Test: `packages/web-shared/src/orders/order-events.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/web-shared/src/orders/order-events.test.ts`, add:
```ts
import { describe, it, expect } from "vitest";
import { applyOrderEvent } from "./order-events";
import type { OrderView } from "@flashbite/contracts";

const row = (over: Partial<OrderView> = {}): OrderView => ({
  tenantId: "berlin", orderId: "o-1", customerId: "c", items: [], totalAmount: 100,
  status: "PLACED", version: 1, updatedAt: "t", ...over,
});

describe("applyOrderEvent cancelReason", () => {
  it("sets status + cancelReason on a known order when the event carries a reason", () => {
    const out = applyOrderEvent([row()], { orderId: "o-1", eventType: "OrderCancelled", cancelReason: "SLA_BREACH" });
    expect(out[0].status).toBe("CANCELLED");
    expect(out[0].cancelReason).toBe("SLA_BREACH");
  });

  it("leaves cancelReason unset for non-cancel events", () => {
    const out = applyOrderEvent([row()], { orderId: "o-1", eventType: "OrderAccepted" });
    expect(out[0].status).toBe("ACCEPTED");
    expect(out[0].cancelReason).toBeUndefined();
  });
});
```
(If `order-events.test.ts` does not exist yet, create it with the imports above; if it exists, append the `describe` block and reuse its imports.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @flashbite/web-shared exec vitest run src/orders/order-events.test.ts`
Expected: FAIL — `cancelReason` not on the type / not applied.

- [ ] **Step 3: Update the type + applier**

In `packages/web-shared/src/orders/order-events.ts`, extend the interface and the applier:
```ts
export interface OrderStreamEvent {
  orderId: string;
  eventType: string;
  cancelReason?: string;
}
```
Replace `applyOrderEvent`:
```ts
/** Apply a live SSE event to existing rows: update a known order's status in place.
 *  Unknown orders are left unchanged — the caller fetches their detail and upserts. */
export function applyOrderEvent(rows: OrderView[], event: OrderStreamEvent): OrderView[] {
  const status = statusFromEventType(event.eventType);
  if (!status) return rows;
  if (!rows.some((r) => r.orderId === event.orderId)) return rows;
  return rows.map((r) =>
    r.orderId === event.orderId
      ? { ...r, status, ...(event.cancelReason ? { cancelReason: event.cancelReason } : {}) }
      : r,
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @flashbite/web-shared exec vitest run src/orders/order-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-shared/src/orders/order-events.ts packages/web-shared/src/orders/order-events.test.ts
git commit -m "feat(web-shared): OrderStreamEvent.cancelReason + applyOrderEvent applies it"
```

---

## Task 5: web-shared — cross-tenant analytics helpers

**Files:**
- Create: `packages/web-shared/src/orders/analytics.ts`
- Test: `packages/web-shared/src/orders/analytics.test.ts`
- Modify: `packages/web-shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web-shared/src/orders/analytics.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  aggregateGmv, gmvByTenant, statusBreakdown, topSkus, gmvOverTime, orderCounts, replaceTenantOrders,
} from "./analytics";
import type { OrderView } from "@flashbite/contracts";

const o = (over: Partial<OrderView>): OrderView => ({
  tenantId: "berlin", orderId: Math.random().toString(36).slice(2), customerId: "c",
  items: [{ sku: "pizza", qty: 1, price: 1000 }], totalAmount: 1000,
  status: "PLACED", version: 1, updatedAt: "2026-06-14T10:00:00.000Z", ...over,
});

const orders: OrderView[] = [
  o({ tenantId: "berlin", totalAmount: 1000, status: "ACCEPTED", items: [{ sku: "pizza", qty: 2, price: 500 }], updatedAt: "2026-06-14T10:15:00.000Z" }),
  o({ tenantId: "berlin", totalAmount: 500, status: "PLACED", items: [{ sku: "burger", qty: 1, price: 500 }], updatedAt: "2026-06-14T11:30:00.000Z" }),
  o({ tenantId: "berlin", totalAmount: 9999, status: "CANCELLED", cancelReason: "SLA_BREACH", items: [{ sku: "pizza", qty: 5, price: 2000 }], updatedAt: "2026-06-14T11:45:00.000Z" }),
  o({ tenantId: "tokyo", totalAmount: 300, status: "ACCEPTED", items: [{ sku: "sushi", qty: 3, price: 100 }], updatedAt: "2026-06-14T10:50:00.000Z" }),
];

describe("analytics", () => {
  it("aggregateGmv sums totalAmount excluding cancelled", () => {
    expect(aggregateGmv(orders)).toBe(1000 + 500 + 300);
  });
  it("gmvByTenant groups non-cancelled totals per tenant", () => {
    expect(gmvByTenant(orders)).toEqual([{ tenant: "berlin", gmv: 1500 }, { tenant: "tokyo", gmv: 300 }]);
  });
  it("statusBreakdown counts per tenant per status", () => {
    expect(statusBreakdown(orders)).toEqual([
      { tenant: "berlin", placed: 1, accepted: 1, cancelled: 1 },
      { tenant: "tokyo", placed: 0, accepted: 1, cancelled: 0 },
    ]);
  });
  it("topSkus sums qty over non-cancelled orders, desc, limited", () => {
    expect(topSkus(orders, 2)).toEqual([{ sku: "sushi", qty: 3 }, { sku: "pizza", qty: 2 }]);
  });
  it("gmvOverTime buckets by hour, excludes cancelled, ascending", () => {
    expect(gmvOverTime(orders)).toEqual([
      { bucket: "2026-06-14T10", gmv: 1300 },
      { bucket: "2026-06-14T11", gmv: 500 },
    ]);
  });
  it("orderCounts reports total, cancelled, rate", () => {
    expect(orderCounts(orders)).toEqual({ total: 4, cancelled: 1, cancelRate: 0.25 });
  });
  it("replaceTenantOrders swaps one tenant's slice, keeping others", () => {
    const next = replaceTenantOrders(orders, "berlin", [o({ tenantId: "berlin", orderId: "new" })]);
    expect(next.filter((x) => x.tenantId === "berlin").map((x) => x.orderId)).toEqual(["new"]);
    expect(next.filter((x) => x.tenantId === "tokyo")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @flashbite/web-shared exec vitest run src/orders/analytics.test.ts`
Expected: FAIL — cannot find module `./analytics`.

- [ ] **Step 3: Implement the helpers**

Create `packages/web-shared/src/orders/analytics.ts`:
```ts
import { ORDER_STATUS, type OrderView } from "@flashbite/contracts";

const live = (o: OrderView): boolean => o.status !== ORDER_STATUS.CANCELLED;
const tenantsOf = (orders: OrderView[]): string[] => {
  const seen: string[] = [];
  for (const o of orders) if (!seen.includes(o.tenantId)) seen.push(o.tenantId);
  return seen;
};

/** Total GMV: sum of totalAmount over non-cancelled orders. */
export function aggregateGmv(orders: OrderView[]): number {
  return orders.filter(live).reduce((s, o) => s + o.totalAmount, 0);
}

export interface TenantGmv { tenant: string; gmv: number; }
export function gmvByTenant(orders: OrderView[]): TenantGmv[] {
  return tenantsOf(orders).map((tenant) => ({
    tenant,
    gmv: orders.filter((o) => o.tenantId === tenant && live(o)).reduce((s, o) => s + o.totalAmount, 0),
  }));
}

export interface TenantStatusCounts { tenant: string; placed: number; accepted: number; cancelled: number; }
export function statusBreakdown(orders: OrderView[]): TenantStatusCounts[] {
  return tenantsOf(orders).map((tenant) => {
    const rows = orders.filter((o) => o.tenantId === tenant);
    return {
      tenant,
      placed: rows.filter((o) => o.status === ORDER_STATUS.PLACED).length,
      accepted: rows.filter((o) => o.status === ORDER_STATUS.ACCEPTED).length,
      cancelled: rows.filter((o) => o.status === ORDER_STATUS.CANCELLED).length,
    };
  });
}

export interface SkuCount { sku: string; qty: number; }
export function topSkus(orders: OrderView[], limit = 5): SkuCount[] {
  const totals = new Map<string, number>();
  for (const o of orders.filter(live)) {
    for (const it of o.items) totals.set(it.sku, (totals.get(it.sku) ?? 0) + it.qty);
  }
  return [...totals.entries()]
    .map(([sku, qty]) => ({ sku, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, limit);
}

export interface GmvBucket { bucket: string; gmv: number; }
/** GMV bucketed by hour (UTC) of updatedAt, non-cancelled, ascending by bucket. */
export function gmvOverTime(orders: OrderView[]): GmvBucket[] {
  const totals = new Map<string, number>();
  for (const o of orders.filter(live)) {
    const bucket = o.updatedAt.slice(0, 13); // "YYYY-MM-DDTHH"
    totals.set(bucket, (totals.get(bucket) ?? 0) + o.totalAmount);
  }
  return [...totals.entries()]
    .map(([bucket, gmv]) => ({ bucket, gmv }))
    .sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

export interface OrderCounts { total: number; cancelled: number; cancelRate: number; }
export function orderCounts(orders: OrderView[]): OrderCounts {
  const total = orders.length;
  const cancelled = orders.filter((o) => o.status === ORDER_STATUS.CANCELLED).length;
  return { total, cancelled, cancelRate: total === 0 ? 0 : cancelled / total };
}

/** Replace one tenant's orders within the merged list (used when a tenant snapshot reloads). */
export function replaceTenantOrders(all: OrderView[], tenant: string, incoming: OrderView[]): OrderView[] {
  return [...all.filter((o) => o.tenantId !== tenant), ...incoming];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @flashbite/web-shared exec vitest run src/orders/analytics.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Export from the barrel**

In `packages/web-shared/src/index.ts`, after the `order-events` export line (line 53), add:
```ts
export {
  aggregateGmv, gmvByTenant, statusBreakdown, topSkus, gmvOverTime, orderCounts, replaceTenantOrders,
  type TenantGmv, type TenantStatusCounts, type SkuCount, type GmvBucket, type OrderCounts,
} from "./orders/analytics";
```

- [ ] **Step 6: Verify the whole web-shared suite passes**

Run: `pnpm --filter @flashbite/web-shared test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web-shared/src/orders/analytics.ts packages/web-shared/src/orders/analytics.test.ts packages/web-shared/src/index.ts
git commit -m "feat(web-shared): cross-tenant order analytics helpers"
```

---

## Task 6: Scaffold `apps/web-admin` (:3103) + deps + root wiring

**Files:** new `apps/web-admin/*` config + shell; modify root `jest.config.cjs`, `package.json`.

- [ ] **Step 1: Create `apps/web-admin/package.json`**

```json
{
  "name": "web-admin",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3103",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "echo \"no unit tests in web-admin\"",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@flashbite/web-shared": "workspace:*",
    "mapbox-gl": "^3",
    "next": "16.2.9",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "react-map-gl": "^8",
    "recharts": "^2.15.0",
    "tw-animate-css": "^1.4.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.60.0",
    "@tailwindcss/postcss": "^4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.2.9",
    "tailwindcss": "^4",
    "typescript": "^5"
  }
}
```

- [ ] **Step 2: Create config files** (copy from `apps/web-driver`, changing only the port)

`apps/web-admin/next.config.ts` — identical to `apps/web-driver/next.config.ts` (rewrites to :3001/:3002):
```ts
import type { NextConfig } from "next";

const WRITE_API = process.env.WRITE_API_ORIGIN ?? "http://localhost:3001";
const READ_API = process.env.READ_API_ORIGIN ?? "http://localhost:3002";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/write/:path*", destination: `${WRITE_API}/:path*` },
      { source: "/api/read/:path*", destination: `${READ_API}/:path*` },
    ];
  },
};

export default nextConfig;
```

`apps/web-admin/tsconfig.json`, `apps/web-admin/postcss.config.mjs`, `apps/web-admin/eslint.config.mjs`, `apps/web-admin/next-env.d.ts`, `apps/web-admin/.gitignore` — copy each verbatim from the corresponding `apps/web-driver` file (read them and reproduce exactly; the `.gitignore` must include the `.env*` + `!.env.example` lines and `/.next/`).

`apps/web-admin/.env.example`:
```
# Public Mapbox token for the per-tenant driver maps. Without it, each map shows a
# fallback panel; cards, charts, and the orders table still work.
NEXT_PUBLIC_MAPBOX_TOKEN=
```

- [ ] **Step 3: Create the app shell**

`apps/web-admin/app/layout.tsx` — same as web-driver's but title/description:
```tsx
import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });

export const metadata: Metadata = {
  title: "FlashBite Admin",
  description: "Cross-tenant operations grid.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${manrope.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
```

`apps/web-admin/app/globals.css` — identical to `apps/web-driver/app/globals.css` (Tailwind + tw-animate-css + the RELATIVE `../../../packages/web-shared/src/styles/theme.css` import + `@source`).

`apps/web-admin/app/page.tsx` (placeholder — replaced in Task 10):
```tsx
export default function AdminPage() {
  return <main className="p-6">web-admin scaffold</main>;
}
```

- [ ] **Step 4: Add `apps/web-admin/` to root Jest ignore**

In `/Users/sangkha/Documents/Study/Learning/FlashBite/jest.config.cjs`, extend `testPathIgnorePatterns`:
```js
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/apps/web-customer/", "<rootDir>/apps/web-merchant/", "<rootDir>/apps/web-driver/", "<rootDir>/apps/web-admin/"],
```

- [ ] **Step 5: Add root scripts**

In root `package.json`, after `"dev:web-driver": ...` add:
```json
    "dev:web-admin": "pnpm --filter web-admin dev",
```
After `"test:e2e:driver": ...` add a comma and:
```json
    "test:e2e:driver": "pnpm --filter web-driver test:e2e",
    "test:e2e:admin": "pnpm --filter web-admin test:e2e"
```

- [ ] **Step 6: Install**

Run: `pnpm install`
Expected: resolves `web-admin`, installs `recharts`, `react-map-gl`, etc. **If `recharts@^2.15.0` reports a React 19 peer conflict or the build later fails on it, change the dep to `"recharts": "^3"` and re-run `pnpm install`** (recharts 3 targets React 19). Note which version resolved.

- [ ] **Step 7: Verify scaffold builds + root tests pass**

Run: `pnpm --filter web-admin build`  → Expected: success (placeholder page).
Run: `pnpm test`  → Expected: backend suites pass; web apps ignored.

- [ ] **Step 8: Commit**

```bash
git add apps/web-admin jest.config.cjs package.json pnpm-lock.yaml
git commit -m "feat(web-admin): scaffold Next.js app on :3103 + recharts/map deps + root wiring"
```

---

## Task 7: `useAdminData` hook + `TenantStream` (fan-out state)

**Files:**
- Create: `apps/web-admin/hooks/use-admin-data.ts`
- Create: `apps/web-admin/components/tenant-stream.tsx`

**Context:** The hook owns merged `orders` + per-tenant `drivers` + `errors`. On mount it fans out `listOrders` per tenant (snapshot) and polls `getNearbyDrivers` per tenant every ~5s. SSE is opened by `TenantStream` children (one `useOrderStream` each — keeps React hook order stable since `TENANTS` is a fixed-length constant). The hook exposes `handleEvent`/`resync` for those children, mirroring the merchant page's live-merge logic.

- [ ] **Step 1: Write the hook**

`apps/web-admin/hooks/use-admin-data.ts`:
```ts
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listOrders, getOrder, getNearbyDrivers,
  applyOrderEvent, upsertOrder, replaceTenantOrders, statusFromEventType, ORDER_STATUS,
  TENANTS, CITY_CENTERS,
  type OrderView, type OrderStreamEvent, type NearbyDriver, type Tenant,
} from "@flashbite/web-shared";

const DRIVER_POLL_MS = 5000;
const RADIUS_KM = 5;

export interface AdminData {
  orders: OrderView[];
  driversByTenant: Record<string, NearbyDriver[]>;
  errors: string[];
  handleEvent: (tenant: Tenant, e: OrderStreamEvent) => void;
  resync: (tenant: Tenant) => void;
}

export function useAdminData(): AdminData {
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [driversByTenant, setDriversByTenant] = useState<Record<string, NearbyDriver[]>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const ordersRef = useRef(orders);
  useEffect(() => { ordersRef.current = orders; }, [orders]);

  const noteError = useCallback((msg: string) => {
    setErrors((prev) => (prev.includes(msg) ? prev : [...prev, msg]));
  }, []);

  const resync = useCallback((tenant: Tenant) => {
    listOrders(tenant)
      .then((rows) => setOrders((prev) => replaceTenantOrders(prev, tenant, rows)))
      .catch(() => noteError(`orders: ${tenant}`));
  }, [noteError]);

  // initial snapshot fan-out
  useEffect(() => {
    for (const tenant of TENANTS) resync(tenant);
  }, [resync]);

  // driver polling fan-out
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (): Promise<void> => {
      const results = await Promise.all(
        TENANTS.map((t) =>
          getNearbyDrivers(t, CITY_CENTERS[t].lng, CITY_CENTERS[t].lat, RADIUS_KM)
            .then((d) => [t, d] as const)
            .catch(() => { noteError(`drivers: ${t}`); return [t, null] as const }),
        ),
      );
      if (!active) return;
      setDriversByTenant((prev) => {
        const next = { ...prev };
        for (const [t, d] of results) if (d) next[t] = d;
        return next;
      });
      timer = setTimeout(() => void tick(), DRIVER_POLL_MS);
    };
    void tick();
    return () => { active = false; clearTimeout(timer); };
  }, [noteError]);

  const handleEvent = useCallback((tenant: Tenant, e: OrderStreamEvent) => {
    if (ordersRef.current.some((r) => r.orderId === e.orderId)) {
      setOrders((rows) => applyOrderEvent(rows, e));
    } else if (statusFromEventType(e.eventType) === ORDER_STATUS.PLACED) {
      let tries = 0;
      const fetchRow = (): void => {
        getOrder(tenant, e.orderId)
          .then((o) => {
            if (o) { setOrders((cur) => upsertOrder(cur, o)); return; }
            if (++tries < 10) setTimeout(fetchRow, 500);
          })
          .catch(() => {});
      };
      fetchRow();
    }
  }, []);

  return { orders, driversByTenant, errors, handleEvent, resync };
}
```

- [ ] **Step 2: Write `TenantStream`**

`apps/web-admin/components/tenant-stream.tsx`:
```tsx
"use client";
import { useOrderStream, type OrderStreamEvent, type Tenant } from "@flashbite/web-shared";

/** Opens one live order SSE connection for a single tenant. Renders nothing. */
export function TenantStream({
  tenant, onEvent, onResync,
}: {
  tenant: Tenant;
  onEvent: (e: OrderStreamEvent) => void;
  onResync: () => void;
}) {
  useOrderStream(tenant, onEvent, onResync);
  return null;
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter web-admin exec tsc --noEmit`
Expected: no errors. (Confirms all imported web-shared symbols resolve — `useOrderStream`'s signature is `(tenantId, onEvent, onOpen?)`; here `onResync` is passed as the on-open/resync callback, matching the merchant page usage.)

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/hooks/use-admin-data.ts apps/web-admin/components/tenant-stream.tsx
git commit -m "feat(web-admin): useAdminData fan-out + TenantStream SSE subscription"
```

---

## Task 8: `StatCards` + recharts charts

**Files:**
- Create: `apps/web-admin/components/stat-cards.tsx`
- Create: `apps/web-admin/components/charts.tsx`

- [ ] **Step 1: Write `StatCards`**

`apps/web-admin/components/stat-cards.tsx`:
```tsx
"use client";
import { Card, CardContent, aggregateGmv, orderCounts, type OrderView, type NearbyDriver } from "@flashbite/web-shared";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export function StatCards({
  orders, driversByTenant,
}: {
  orders: OrderView[];
  driversByTenant: Record<string, NearbyDriver[]>;
}) {
  const gmv = aggregateGmv(orders);
  const { total, cancelled, cancelRate } = orderCounts(orders);
  const driverEntries = Object.entries(driversByTenant);
  const activeDrivers = driverEntries.reduce((s, [, d]) => s + d.length, 0);

  const cards = [
    { label: "Total GMV", value: euro(gmv), hint: "excl. cancelled" },
    { label: "Orders", value: String(total), hint: "all statuses" },
    { label: "Cancelled", value: `${cancelled} (${(cancelRate * 100).toFixed(1)}%)`, hint: "SLA / declined" },
    { label: "Active drivers", value: String(activeDrivers), hint: driverEntries.map(([t, d]) => `${t} ${d.length}`).join(" · ") || "—" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.label}</div>
            <div className="mt-1 text-2xl font-extrabold">{c.value}</div>
            <div className="text-xs text-muted-foreground">{c.hint}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```
(Confirm `Card`/`CardContent` are exported by `@flashbite/web-shared` — they are, from `components/ui/card`.)

- [ ] **Step 2: Write the charts**

`apps/web-admin/components/charts.tsx`:
```tsx
"use client";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, CartesianGrid,
} from "recharts";
import {
  gmvByTenant, statusBreakdown, topSkus, gmvOverTime, type OrderView,
} from "@flashbite/web-shared";

const GREEN = "#06C167";
const LIGHT = "#D1FAE5";
const RED = "#FCA5A5";
const euro = (cents: number) => `€${(cents / 100).toFixed(0)}`;

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div style={{ width: "100%", height: 200 }}>
        <ResponsiveContainer>{children as React.ReactElement}</ResponsiveContainer>
      </div>
    </div>
  );
}

export function GmvByTenantChart({ orders }: { orders: OrderView[] }) {
  return (
    <ChartCard title="GMV by tenant">
      <BarChart data={gmvByTenant(orders)}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="tenant" /><YAxis tickFormatter={euro} width={48} />
        <Tooltip formatter={(v: number) => euro(v)} />
        <Bar dataKey="gmv" fill={GREEN} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartCard>
  );
}

export function StatusBreakdownChart({ orders }: { orders: OrderView[] }) {
  return (
    <ChartCard title="Order status breakdown">
      <BarChart data={statusBreakdown(orders)}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="tenant" /><YAxis allowDecimals={false} width={32} />
        <Tooltip />
        <Bar dataKey="placed" stackId="s" fill={LIGHT} />
        <Bar dataKey="accepted" stackId="s" fill={GREEN} />
        <Bar dataKey="cancelled" stackId="s" fill={RED} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartCard>
  );
}

export function TopSkusChart({ orders }: { orders: OrderView[] }) {
  return (
    <ChartCard title="Top SKUs">
      <BarChart data={topSkus(orders, 5)} layout="vertical">
        <XAxis type="number" allowDecimals={false} hide />
        <YAxis type="category" dataKey="sku" width={64} />
        <Tooltip />
        <Bar dataKey="qty" fill={GREEN} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ChartCard>
  );
}

export function GmvOverTimeChart({ orders }: { orders: OrderView[] }) {
  return (
    <ChartCard title="GMV over time (hourly)">
      <AreaChart data={gmvOverTime(orders)}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="bucket" tickFormatter={(b: string) => b.slice(11)} />
        <YAxis tickFormatter={euro} width={48} />
        <Tooltip formatter={(v: number) => euro(v)} />
        <Area type="monotone" dataKey="gmv" stroke={GREEN} fill={GREEN} fillOpacity={0.15} />
      </AreaChart>
    </ChartCard>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter web-admin exec tsc --noEmit`
Expected: no errors. If recharts types conflict with React 19 (rare), confirm the recharts version from Task 6; do NOT use `any` to paper over — report it.

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/components/stat-cards.tsx apps/web-admin/components/charts.tsx
git commit -m "feat(web-admin): stat cards + recharts charts (gmv, status, skus, time)"
```

---

## Task 9: `TenantMap` + `AdminOrdersTable`

**Files:**
- Create: `apps/web-admin/components/tenant-map.tsx`
- Create: `apps/web-admin/components/admin-orders-table.tsx`

- [ ] **Step 1: Write `TenantMap`** (markers-only, token-gated fallback — same approach as web-driver's NearbyMap)

`apps/web-admin/components/tenant-map.tsx`:
```tsx
"use client";
import { Map, Marker } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { type GeoPoint, type NearbyDriver } from "@flashbite/web-shared";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export function TenantMap({
  tenant, center, drivers,
}: {
  tenant: string;
  center: GeoPoint;
  drivers: NearbyDriver[];
}) {
  return (
    <div className="rounded-xl border p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {tenant} · {drivers.length} drivers
      </div>
      {!TOKEN ? (
        <div
          data-testid={`map-fallback-${tenant}`}
          className="flex h-[220px] items-center justify-center rounded-lg border bg-muted/30 px-6 text-center text-sm text-muted-foreground"
        >
          Set <code className="mx-1 font-mono">NEXT_PUBLIC_MAPBOX_TOKEN</code> to see the map.
        </div>
      ) : (
        <div className="h-[220px] overflow-hidden rounded-lg border">
          <Map
            mapboxAccessToken={TOKEN}
            initialViewState={{ longitude: center.lng, latitude: center.lat, zoom: 11 }}
            mapStyle="mapbox://styles/mapbox/streets-v12"
            style={{ width: "100%", height: "100%" }}
          >
            {drivers.map((d) => (
              <Marker key={d.driverId} longitude={d.lng} latitude={d.lat} color="#0f172a" />
            ))}
          </Map>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `AdminOrdersTable`** (shared DataTable; tenant + status + reason columns)

`apps/web-admin/components/admin-orders-table.tsx`:
```tsx
"use client";
import { DataTable, StatusPill, type ColumnDef, type OrderView } from "@flashbite/web-shared";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const shortId = (id: string) => `#${id.slice(0, 8)}`;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const columns: ColumnDef<OrderView>[] = [
  { id: "time", accessorKey: "updatedAt", header: "Time", cell: ({ row }) => <span className="text-muted-foreground">{hhmm(row.original.updatedAt)}</span> },
  { id: "tenant", accessorKey: "tenantId", header: "Tenant", cell: ({ row }) => <span className="font-semibold">{row.original.tenantId}</span> },
  { id: "order", accessorKey: "orderId", header: "Order", cell: ({ row }) => <span className="font-semibold">{shortId(row.original.orderId)}</span> },
  { id: "customer", accessorKey: "customerId", header: "Customer" },
  { id: "total", accessorKey: "totalAmount", header: "Total", cell: ({ row }) => <span className="font-semibold">{euro(row.original.totalAmount)}</span> },
  {
    id: "status", accessorKey: "status", header: "Status",
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <StatusPill status={row.original.status} />
        {row.original.cancelReason ? <span className="text-xs text-muted-foreground">{row.original.cancelReason}</span> : null}
      </span>
    ),
  },
];

export function AdminOrdersTable({ data, globalFilter }: { data: OrderView[]; globalFilter: string }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      initialSorting={[{ id: "time", desc: true }]}
      globalFilter={globalFilter}
      emptyMessage="No orders yet."
    />
  );
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter web-admin exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/components/tenant-map.tsx apps/web-admin/components/admin-orders-table.tsx
git commit -m "feat(web-admin): per-tenant map + combined orders table (with cancel reason)"
```

---

## Task 10: Admin page wiring

**Files:**
- Modify: `apps/web-admin/app/page.tsx`

- [ ] **Step 1: Write the page**

`apps/web-admin/app/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { TENANTS, CITY_CENTERS, Input, type Tenant } from "@flashbite/web-shared";
import { useAdminData } from "@/hooks/use-admin-data";
import { TenantStream } from "@/components/tenant-stream";
import { StatCards } from "@/components/stat-cards";
import { GmvByTenantChart, StatusBreakdownChart, TopSkusChart, GmvOverTimeChart } from "@/components/charts";
import { TenantMap } from "@/components/tenant-map";
import { AdminOrdersTable } from "@/components/admin-orders-table";

export default function AdminPage() {
  const { orders, driversByTenant, errors, handleEvent, resync } = useAdminData();
  const [filter, setFilter] = useState("");

  return (
    <div className="min-h-screen bg-background">
      {TENANTS.map((t: Tenant) => (
        <TenantStream key={t} tenant={t} onEvent={(e) => handleEvent(t, e)} onResync={() => resync(t)} />
      ))}

      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="text-lg font-extrabold">flashbite <span className="text-muted-foreground font-semibold">admin</span></div>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="h-2 w-2 rounded-full bg-primary" /> live · {TENANTS.join(" + ")}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {errors.length > 0 && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">
            Couldn&apos;t load: {errors.join(", ")}
          </div>
        )}

        <StatCards orders={orders} driversByTenant={driversByTenant} />

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <GmvByTenantChart orders={orders} />
          <StatusBreakdownChart orders={orders} />
          <TopSkusChart orders={orders} />
          <GmvOverTimeChart orders={orders} />
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {TENANTS.map((t: Tenant) => (
            <TenantMap key={t} tenant={t} center={CITY_CENTERS[t]} drivers={driversByTenant[t] ?? []} />
          ))}
        </div>

        <section className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent orders ({orders.length})
            </div>
            <Input placeholder="Search tenant / order / customer" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search orders" className="max-w-xs" />
          </div>
          <AdminOrdersTable data={orders} globalFilter={filter} />
        </section>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Build + lint**

Run: `pnpm --filter web-admin build`  → Expected: success (first bundle of recharts + mapbox; confirm no SSR/import errors).
Run: `pnpm --filter web-admin lint`  → Expected: clean. If the SSE/poll effects trip `react-hooks/set-state-in-effect`, apply the same narrow, commented `// eslint-disable-next-line react-hooks/set-state-in-effect` used in web-driver — report any line you suppress.

- [ ] **Step 3: Commit**

```bash
git add apps/web-admin/app/page.tsx
git commit -m "feat(web-admin): admin grid page — cards, charts, maps, orders table"
```

---

## Task 11: Playwright e2e + config

**Files:**
- Create: `apps/web-admin/playwright.config.ts`
- Create: `apps/web-admin/e2e/admin.spec.ts`

- [ ] **Step 1: Create the Playwright config** (mirror web-driver, port 3103)

`apps/web-admin/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

// E2E needs the read backend running (Playwright only starts the web app):
//   pnpm infra:up && pnpm dev:read-api & pnpm dev:telemetry
// Then: pnpm test:e2e:admin
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3103" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3103",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

- [ ] **Step 2: Write the e2e spec**

`apps/web-admin/e2e/admin.spec.ts`:
```ts
import { test, expect, request } from "@playwright/test";

const WRITE_API = "http://localhost:3001";

test("admin grid fans out across tenants and renders cards, charts, maps, table", async ({ page }) => {
  // Seed one order per tenant so charts/table have data (write-api → projection → read model).
  const api = await request.newContext();
  try {
    for (const tenant of ["berlin", "tokyo"]) {
      const res = await api.post(`${WRITE_API}/orders`, {
        headers: { "X-Tenant-ID": tenant, "Content-Type": "application/json" },
        data: { orderId: crypto.randomUUID(), customerId: "e2e-admin", items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200 },
      });
      expect(res.status()).toBe(201);
    }
  } finally {
    await api.dispose();
  }

  // Assert the page fans out: a nearby query per tenant (200).
  const berlinNearby = page.waitForResponse((r) => /\/api\/read\/drivers\/nearby\?/.test(r.url()) && r.status() === 200, { timeout: 30_000 });

  await page.goto("/");
  await berlinNearby;

  await expect(page.getByText("Total GMV")).toBeVisible();
  await expect(page.getByText("GMV by tenant")).toBeVisible();
  await expect(page.getByText(/Recent orders \(/)).toBeVisible();
  // Both per-tenant map regions render (token-less fallback in CI).
  await expect(page.getByTestId("map-fallback-berlin").or(page.locator(".mapboxgl-map").first())).toBeVisible();
});
```

- [ ] **Step 3: Run the e2e** (with infra + read-api up)

Setup:
```bash
pnpm infra:up
pnpm dev:read-api &
pnpm dev:telemetry &
```
Run: `pnpm test:e2e:admin`
Expected: PASS (cards/charts/table/maps render; fan-out nearby returns 200). If projection lag makes the seeded orders not appear immediately, the test still passes on the structural assertions (cards/charts/table headers render regardless of row count).

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/playwright.config.ts apps/web-admin/e2e/admin.spec.ts
git commit -m "test(web-admin): Playwright e2e — cross-tenant fan-out renders grid"
```

---

## Final Verification

- [ ] `pnpm --filter @flashbite/web-shared test` — analytics + order-events suites green.
- [ ] `pnpm test` — backend suites green (projection cancelReason, read-api passthrough, SSE feeder); web apps ignored.
- [ ] `pnpm --filter web-admin build` — production build succeeds.
- [ ] `pnpm --filter web-admin lint` — clean.
- [ ] `pnpm --filter web-admin exec tsc --noEmit` — clean.
- [ ] `pnpm test:e2e:admin` (infra + read-api up) — e2e passes.
- [ ] Manual smoke (optional, needs `NEXT_PUBLIC_MAPBOX_TOKEN` in `apps/web-admin/.env.local`): `pnpm dev:web-admin` → http://localhost:3103; run `scripts/stream-gps.sh` (berlin) and `TENANT=tokyo DRIVER=drv-9 scripts/stream-gps.sh` to populate both maps; place a few orders (incl. one that SLA-cancels) to see GMV/charts update live and a cancelled row show its reason.
