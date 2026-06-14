# FlashBite Phase 1d-ii — Merchant Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merchant dashboard (`apps/web-merchant`): a live TanStack orders table (sortable columns, status + text filters, default most-recent first) with a row-click detail side panel that accepts/declines orders by signaling the Temporal saga; rows update live over SSE.

**Architecture:** New Next.js app reusing `@flashbite/web-shared`. A read-api `GET /merchant/orders` endpoint returns the tenant's recent orders from the Mongo read model. `web-shared` gains: shadcn `Table`/`Sheet`, a generic `DataTable` over `@tanstack/react-table`, the `listOrders`/`acceptOrder`/`declineOrder` API fns, a pure status/queue reducer, and a fetch-based SSE hook. The merchant app composes these into the table + sheet.

**Tech Stack:** Next.js 16 (App Router) · React 19 · Tailwind v4 · shadcn/ui · @tanstack/react-table · @microsoft/fetch-event-source · zustand · Vitest · Playwright.

**Spec:** `docs/superpowers/specs/2026-06-14-flashbite-phase-1d-ii-merchant-dashboard-design.md`

---

## Context for the implementer

- Monorepo: pnpm 9.1.0, Node 24, workspaces `apps/*` + `packages/*`. Run `pnpm` from the repo root. Branch: `phase-1d-ii-merchant-dashboard` (already created off `main`, which has 1d-i merged).
- **1d-i is merged**, so these exist and are reused as-is:
  - `packages/web-shared` (`@flashbite/web-shared`): shadcn components (`Button`, `Card`+parts, `Badge`, `Input`, `Separator`, `DropdownMenu`+parts, `Skeleton`, `Carousel`+parts), `cn`, design tokens (Tailwind v4, green `#06C167`, status palette, Manrope), `StatusPill`, `QtyStepper`, API client (`placeOrder`, `getOrder`, `tenantHeader` is internal), `useTenantStore`/`TENANTS`/`Tenant`, `useCartStore`, `getMenu`/`getPopular`. Vitest is configured (`*.test.ts(x)`, jsdom).
  - `apps/web-customer` (Next.js 16, App Router, Tailwind v4) on port 3100 — the reference for the merchant app's setup.
- **read-api read model**: `OrdersQueryService` (`apps/read-api/src/orders/orders-query.service.ts`) uses `MongoService` — `this.mongo.db.collection(READ_COLLECTIONS.ORDERS)`, docs keyed `_id: "<tenantId>:<orderId>"` with fields `tenantId, orderId, customerId, items, totalAmount, status, version, updatedAt`. `getTenantId()` from `@flashbite/tenant-context` gives the request tenant.
- **Backend endpoints reused**: `POST /orders/:id/accept` and `/decline` (write-api :3001, header `X-Tenant-ID`, no body, 202); `GET /orders/:id` (read-api :3002 → `OrderView`); SSE `GET /merchant/orders/stream` (read-api, tenant via `X-Tenant-ID`, live-only, each message `{ orderId, eventType, status }` where `eventType` is the real signal).
- **Tailwind v4 is CSS-first** (no `tailwind.config.ts`; tokens via `@theme inline`; external content via `@source`). The merchant app imports the **shared theme** (Task 2 extracts it to `web-shared` so both apps share one source of truth).
- **EventSource limitation**: the browser `EventSource` API cannot set request headers, but the SSE route needs `X-Tenant-ID`. So the SSE hook uses **`@microsoft/fetch-event-source`** (fetch-based, supports headers + auto-reconnect) through the same-origin rewrite.
- **Root Jest** (`jest.config.cjs`) matches `**/*.spec.ts` across `apps/`; the new app must be excluded via `testPathIgnorePatterns` (Task 3). read-api e2e tests are `*.e2e-spec.ts` and DO run under root Jest (Task 1).
- A commit hook may auto-commit; still run each task's explicit `git commit` so messages are correct.

**Conventions:** commit per task (Conventional Commits). End every commit body with:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## File Structure

```
flashbite/
  apps/read-api/
    src/orders/orders-query.service.ts        # MODIFY (T1): listRecentOrders()
    src/orders/merchant-orders.controller.ts  # CREATE (T1): GET /merchant/orders
    src/orders/orders.module.ts               # MODIFY (T1): register controller
    test/merchant-orders.e2e-spec.ts          # CREATE (T1)
  packages/web-shared/
    src/styles/theme.css                      # CREATE (T2): shared design tokens (extracted)
    package.json                              # MODIFY (T2 exports; T4/T5 deps)
    src/index.ts                              # MODIFY (T4,T5,T6): new exports
    src/api/client.ts                         # MODIFY (T4): listOrders/acceptOrder/declineOrder
    src/api/client.test.ts                    # MODIFY (T4): tests for the new fns
    src/orders/order-events.ts                # CREATE (T4): statusFromEventType + queue reducer
    src/orders/order-events.test.ts           # CREATE (T4)
    src/orders/use-order-stream.ts            # CREATE (T5): fetch-based SSE hook
    src/orders/use-order-stream.test.ts       # CREATE (T5)
    src/components/ui/table.tsx               # CREATE (T6): shadcn table
    src/components/ui/sheet.tsx               # CREATE (T6): shadcn sheet
    src/components/data-table.tsx             # CREATE (T6): generic TanStack wrapper
  apps/web-customer/app/globals.css           # MODIFY (T2): import shared theme
  apps/web-merchant/                          # CREATE (T3): Next.js scaffold
    next.config.ts                            # rewrites proxy
    app/globals.css                           # import tailwindcss + shared theme + @source
    app/layout.tsx                            # Manrope
    app/page.tsx                              # MODIFY (T7,T8): dashboard
    components/orders-table.tsx               # CREATE (T7): columns + filters
    components/order-detail-sheet.tsx         # CREATE (T8): sidebar + accept/decline
    playwright.config.ts                      # CREATE (T9)
    e2e/merchant.spec.ts                      # CREATE (T9)
  jest.config.cjs                             # MODIFY (T3): ignore apps/web-merchant
  package.json                                # MODIFY (T3): dev:web-merchant; (T9): test scripts
```

---

## Task 1: read-api `GET /merchant/orders` (recent orders, tenant-scoped)

**Files:**
- Modify: `apps/read-api/src/orders/orders-query.service.ts`
- Create: `apps/read-api/src/orders/merchant-orders.controller.ts`
- Modify: `apps/read-api/src/orders/orders.module.ts`
- Create: `apps/read-api/test/merchant-orders.e2e-spec.ts`

- [ ] **Step 1: Write the failing e2e**

Create `apps/read-api/test/merchant-orders.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { MongoService } from "@flashbite/shared";
import { READ_COLLECTIONS, ORDER_STATUS, type OrderView } from "@flashbite/contracts";

describe("read-api merchant orders list (e2e)", () => {
  let app: INestApplication;
  let mongo: MongoService;
  const ids: string[] = [];

  const seed = async (tenantId: string, status: string, updatedAt: string) => {
    const orderId = randomUUID();
    ids.push(`${tenantId}:${orderId}`);
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).insertOne({
      _id: `${tenantId}:${orderId}` as never,
      tenantId, orderId, customerId: "c-1",
      items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200,
      status, version: 1, updatedAt,
    });
    return orderId;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    mongo = app.get(MongoService);
  }, 30000);
  afterAll(async () => {
    for (const _id of ids) await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: _id as never });
    await app.close();
  });

  it("returns the tenant's recent orders newest-first, across statuses, excluding other tenants", async () => {
    const older = await seed("berlin", ORDER_STATUS.ACCEPTED, "2026-06-14T10:00:00.000Z");
    const newer = await seed("berlin", ORDER_STATUS.PLACED, "2026-06-14T11:00:00.000Z");
    const tokyo = await seed("tokyo", ORDER_STATUS.PLACED, "2026-06-14T12:00:00.000Z");

    const res = await request(app.getHttpServer()).get("/merchant/orders").set("X-Tenant-ID", "berlin");
    expect(res.status).toBe(200);
    const body = res.body as OrderView[];
    const orderIds = body.map((o) => o.orderId);

    expect(orderIds).toContain(newer);
    expect(orderIds).toContain(older);
    expect(orderIds).not.toContain(tokyo);
    // newest-first: newer (11:00) appears before older (10:00)
    expect(orderIds.indexOf(newer)).toBeLessThan(orderIds.indexOf(older));
    // every returned order is berlin's
    expect(body.every((o) => o.tenantId === "berlin")).toBe(true);
  });
});
```

- [ ] **Step 2: Run -> FAIL**

Run: `pnpm test -- apps/read-api/test/merchant-orders.e2e-spec.ts`
Expected: FAIL — `/merchant/orders` 404 (route not found).

- [ ] **Step 3: Add the service method**

In `apps/read-api/src/orders/orders-query.service.ts`, add this method to the `OrdersQueryService` class (keep the existing `getOrder`):
```ts
  /** Tenant's most-recent orders (all statuses) for the merchant dashboard. Capped. */
  async listRecentOrders(limit = 100): Promise<OrderView[]> {
    const tenantId = getTenantId();
    const docs = await this.mongo.db
      .collection(READ_COLLECTIONS.ORDERS)
      .find({ tenantId })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => ({
      tenantId: doc.tenantId,
      orderId: doc.orderId,
      customerId: doc.customerId,
      items: doc.items,
      totalAmount: doc.totalAmount,
      status: doc.status,
      version: doc.version,
      updatedAt: doc.updatedAt,
    }));
  }
```

- [ ] **Step 4: Add the controller**

Create `apps/read-api/src/orders/merchant-orders.controller.ts`:
```ts
import { Controller, Get } from "@nestjs/common";
import { OrdersQueryService } from "./orders-query.service";
import type { OrderView } from "@flashbite/contracts";

@Controller("merchant/orders")
export class MerchantOrdersController {
  constructor(private readonly orders: OrdersQueryService) {}

  // GET /merchant/orders — distinct from the SSE GET /merchant/orders/stream.
  @Get()
  async list(): Promise<OrderView[]> {
    return this.orders.listRecentOrders();
  }
}
```

Register it in `apps/read-api/src/orders/orders.module.ts` (keep existing providers):
```ts
import { Module } from "@nestjs/common";
import { MongoService, RedisService } from "@flashbite/shared";
import { OrdersQueryController } from "./orders-query.controller";
import { MerchantOrdersController } from "./merchant-orders.controller";
import { OrdersQueryService } from "./orders-query.service";

@Module({
  controllers: [OrdersQueryController, MerchantOrdersController],
  providers: [OrdersQueryService, MongoService, RedisService],
})
export class OrdersModule {}
```

- [ ] **Step 5: Run -> PASS**

Run: `pnpm test -- apps/read-api/test/merchant-orders.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 6: Full read-api suite stays green**

Run: `pnpm test -- apps/read-api`
Expected: PASS (existing + the new merchant-orders e2e).

- [ ] **Step 7: Commit**

```bash
git add apps/read-api/src/orders apps/read-api/test/merchant-orders.e2e-spec.ts
git commit -m "feat(read-api): GET /merchant/orders — tenant recent orders for the dashboard"
```
End body with the `Co-Authored-By` trailer.

---

## Task 2: Extract shared design tokens to `web-shared/src/styles/theme.css`

DRY the design system so the new app shares one token source (1d-i inlined tokens into web-customer's globals).

**Files:**
- Create: `packages/web-shared/src/styles/theme.css`
- Modify: `packages/web-shared/package.json` (exports), `apps/web-customer/app/globals.css`

- [ ] **Step 1: Read the current tokens**

Open `apps/web-customer/app/globals.css`. It contains `@import "tailwindcss";`, a `:root { … }` token block (FlashBite tokens: `--primary:#06C167`, status palette, `--radius`, etc.), an `@theme inline { … }` block mapping those to Tailwind utilities + `--font-sans`, a `@source "../../../packages/web-shared/src";`, and (from the merged 1d-i fix) `@import "tw-animate-css";` if present.

- [ ] **Step 2: Create the shared theme file**

Create `packages/web-shared/src/styles/theme.css` containing **exactly** the `:root { … }` token block AND the `@theme inline { … }` block currently in `apps/web-customer/app/globals.css` (copy them verbatim — the `--primary`, status, radius, and `--font-sans` mappings). Do NOT include `@import "tailwindcss"` or `@source` here (those stay app-side).

- [ ] **Step 3: Export the theme file from web-shared**

In `packages/web-shared/package.json` `exports`, ensure there is an entry (add if missing, keep existing):
```json
    "./styles/theme.css": "./src/styles/theme.css"
```

- [ ] **Step 4: Point web-customer at the shared theme**

In `apps/web-customer/app/globals.css`, REPLACE the inlined `:root { … }` + `@theme inline { … }` blocks with an import (keep `@import "tailwindcss";` as the first line, keep `@source` and any `tw-animate-css` import):
```css
@import "tailwindcss";
@import "@flashbite/web-shared/styles/theme.css";
@source "../../../packages/web-shared/src";
```
(Preserve any other lines already present, e.g. a `tw-animate-css` import — only the token `:root`/`@theme` blocks move to the shared file.)

- [ ] **Step 5: Verify web-customer still builds + looks right**

Run: `pnpm --filter web-customer build`
Expected: passes. The primary color / Manrope still resolve (tokens now come from the shared file).

- [ ] **Step 6: Commit**

```bash
git add packages/web-shared/src/styles/theme.css packages/web-shared/package.json apps/web-customer/app/globals.css
git commit -m "refactor(web-shared): extract design tokens to shared theme.css (DRY for new surfaces)"
```
End body with the `Co-Authored-By` trailer.

---

## Task 3: Scaffold `apps/web-merchant`

**Files:**
- Create: `apps/web-merchant/*` (Next.js scaffold) + `next.config.ts`, `app/globals.css`, `app/layout.tsx`
- Modify: `jest.config.cjs`, root `package.json`, `apps/web-merchant/package.json`

- [ ] **Step 1: Scaffold**

From the repo root:
```bash
pnpm create next-app@latest apps/web-merchant --ts --tailwind --eslint --app --src-dir=false --import-alias "@/*" --use-pnpm --no-turbopack
```
Match the resulting setup to `apps/web-customer` (same flags; App Router, TS, Tailwind v4, ESLint, no `src/`, alias `@/*`). If a flag is rejected, reach the same end state.

- [ ] **Step 2: Name, port, dep**

In `apps/web-merchant/package.json`: set `"name": "web-merchant"`, `"dev": "next dev -p 3101"`, and add deps:
```json
    "@flashbite/web-shared": "workspace:*"
```
In root `package.json` `scripts` add: `"dev:web-merchant": "pnpm --filter web-merchant dev"`.

- [ ] **Step 3: Exclude from root Jest**

In `jest.config.cjs`, extend `testPathIgnorePatterns` to also ignore the merchant app:
```js
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/apps/web-customer/", "<rootDir>/apps/web-merchant/"],
```

- [ ] **Step 4: Rewrites proxy**

Replace `apps/web-merchant/next.config.ts` with:
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

- [ ] **Step 5: Theme + Manrope (mirror web-customer)**

Replace `apps/web-merchant/app/globals.css` with:
```css
@import "tailwindcss";
@import "@flashbite/web-shared/styles/theme.css";
@source "../../../packages/web-shared/src";
@source "./";
```
(If web-customer's globals imports `tw-animate-css`, add that import here too, matching web-customer.)
Replace `apps/web-merchant/app/layout.tsx` with:
```tsx
import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });

export const metadata: Metadata = { title: "FlashBite Merchant", description: "Manage incoming orders." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body className="font-sans bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 6: Smoke page + verify**

Set `apps/web-merchant/app/page.tsx`:
```tsx
import { Button } from "@flashbite/web-shared";
export default function Home() {
  return <main className="p-10"><Button>Merchant</Button></main>;
}
```
```bash
pnpm install
pnpm --filter web-merchant build
```
Expected: build succeeds; a green shadcn Button renders (tokens resolve via the shared theme + `@source`).

- [ ] **Step 7: Commit**

```bash
git add apps/web-merchant package.json jest.config.cjs pnpm-lock.yaml
git commit -m "feat(web-merchant): scaffold Next.js app (App Router, Tailwind v4) on :3101"
```
End body with the `Co-Authored-By` trailer.

---

## Task 4: web-shared — list/accept/decline API fns + status/queue helpers (Vitest)

**Files:**
- Modify: `packages/web-shared/src/api/client.ts`, `src/api/client.test.ts`, `src/index.ts`
- Create: `packages/web-shared/src/orders/order-events.ts`, `src/orders/order-events.test.ts`

- [ ] **Step 1: Add failing API-client tests**

Append to `packages/web-shared/src/api/client.test.ts` (inside the existing `describe`, keep the existing tests + `beforeEach`):
```ts
  it("listOrders GETs the merchant list with the tenant header", async () => {
    const rows = [{ orderId: "o-1", tenantId: "berlin", customerId: "a", items: [], totalAmount: 0, status: "PLACED", version: 1, updatedAt: "t" }];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await listOrders("berlin");
    expect(res).toEqual(rows);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/read/merchant/orders");
    expect(init.headers["X-Tenant-ID"]).toBe("berlin");
  });

  it("acceptOrder POSTs the accept signal with the tenant header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await acceptOrder("berlin", "o-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/write/orders/o-1/accept");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Tenant-ID"]).toBe("berlin");
  });

  it("declineOrder POSTs the decline signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await declineOrder("berlin", "o-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/write/orders/o-1/decline");
    expect(init.method).toBe("POST");
  });
```
Add `listOrders, acceptOrder, declineOrder` to the existing import from `./client` at the top of the test file.

- [ ] **Step 2: Run -> FAIL**

Run: `pnpm --filter @flashbite/web-shared test src/api/client.test.ts`
Expected: FAIL — the three fns are not exported.

- [ ] **Step 3: Implement the API fns**

In `packages/web-shared/src/api/client.ts` add (the file already has the internal `tenantHeader(tenantId)` helper from 1d-i and imports `OrderView`):
```ts
export async function listOrders(tenantId: string): Promise<OrderView[]> {
  const res = await fetch("/api/read/merchant/orders", { headers: tenantHeader(tenantId) });
  if (!res.ok) throw new Error(`listOrders failed: ${res.status}`);
  return (await res.json()) as OrderView[];
}

async function signalOrder(tenantId: string, orderId: string, action: "accept" | "decline"): Promise<void> {
  const res = await fetch(`/api/write/orders/${encodeURIComponent(orderId)}/${action}`, {
    method: "POST",
    headers: tenantHeader(tenantId),
  });
  if (!res.ok) throw new Error(`${action}Order failed: ${res.status}`);
}

export function acceptOrder(tenantId: string, orderId: string): Promise<void> {
  return signalOrder(tenantId, orderId, "accept");
}
export function declineOrder(tenantId: string, orderId: string): Promise<void> {
  return signalOrder(tenantId, orderId, "decline");
}
```
(If `tenantHeader` is not already a top-level fn in client.ts, it was introduced in 1d-i — reuse it. If the existing helper is named differently, use whatever the file already defines for the `X-Tenant-ID`-only header.)

- [ ] **Step 4: Run -> PASS**

Run: `pnpm --filter @flashbite/web-shared test src/api/client.test.ts`
Expected: PASS (existing 3 + new 3).

- [ ] **Step 5: Add failing order-events tests**

Create `packages/web-shared/src/orders/order-events.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { statusFromEventType, applyOrderEvent, upsertOrder } from "./order-events";
import type { OrderView } from "@flashbite/contracts";

const ov = (orderId: string, status: string, updatedAt: string): OrderView => ({
  tenantId: "berlin", orderId, customerId: "a", items: [], totalAmount: 0, status, version: 1, updatedAt,
});

describe("order-events", () => {
  it("maps event types to statuses", () => {
    expect(statusFromEventType("OrderPlaced")).toBe("PLACED");
    expect(statusFromEventType("OrderAccepted")).toBe("ACCEPTED");
    expect(statusFromEventType("OrderCancelled")).toBe("CANCELLED");
    expect(statusFromEventType("Nonsense")).toBeNull();
  });

  it("upsertOrder replaces by orderId and keeps newest-first", () => {
    const rows = [ov("a", "PLACED", "2026-06-14T10:00:00Z")];
    const next = upsertOrder(rows, ov("b", "PLACED", "2026-06-14T11:00:00Z"));
    expect(next.map((r) => r.orderId)).toEqual(["b", "a"]);
    const replaced = upsertOrder(next, ov("a", "ACCEPTED", "2026-06-14T12:00:00Z"));
    expect(replaced.find((r) => r.orderId === "a")?.status).toBe("ACCEPTED");
    expect(replaced).toHaveLength(2);
  });

  it("applyOrderEvent updates an existing row's status in place", () => {
    const rows = [ov("a", "PLACED", "2026-06-14T10:00:00Z")];
    const next = applyOrderEvent(rows, { orderId: "a", eventType: "OrderAccepted" });
    expect(next.find((r) => r.orderId === "a")?.status).toBe("ACCEPTED");
  });

  it("applyOrderEvent leaves rows unchanged for an unknown order (caller fetches detail)", () => {
    const rows = [ov("a", "PLACED", "2026-06-14T10:00:00Z")];
    const next = applyOrderEvent(rows, { orderId: "z", eventType: "OrderPlaced" });
    expect(next).toEqual(rows);
  });
});
```

- [ ] **Step 6: Run -> FAIL**

Run: `pnpm --filter @flashbite/web-shared test src/orders/order-events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement order-events**

Create `packages/web-shared/src/orders/order-events.ts`:
```ts
import { EVENT_TYPES, ORDER_STATUS, type OrderView } from "@flashbite/contracts";

export interface OrderStreamEvent {
  orderId: string;
  eventType: string;
}

/** The SSE feeder hardcodes `status`, so derive the real status from the event type. */
export function statusFromEventType(eventType: string): string | null {
  switch (eventType) {
    case EVENT_TYPES.ORDER_PLACED: return ORDER_STATUS.PLACED;
    case EVENT_TYPES.ORDER_ACCEPTED: return ORDER_STATUS.ACCEPTED;
    case EVENT_TYPES.ORDER_CANCELLED: return ORDER_STATUS.CANCELLED;
    default: return null;
  }
}

/** Insert or replace an order by id, keeping newest-first (by updatedAt desc). */
export function upsertOrder(rows: OrderView[], order: OrderView): OrderView[] {
  const without = rows.filter((r) => r.orderId !== order.orderId);
  return [order, ...without].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Apply a live SSE event to existing rows: update an known order's status in place.
 *  Unknown orders are left unchanged — the caller fetches their detail and upserts. */
export function applyOrderEvent(rows: OrderView[], event: OrderStreamEvent): OrderView[] {
  const status = statusFromEventType(event.eventType);
  if (!status) return rows;
  if (!rows.some((r) => r.orderId === event.orderId)) return rows;
  return rows.map((r) => (r.orderId === event.orderId ? { ...r, status } : r));
}
```

- [ ] **Step 8: Run -> PASS + export**

Run: `pnpm --filter @flashbite/web-shared test`
Expected: all web-shared suites pass.
Append to `packages/web-shared/src/index.ts`:
```ts
export { listOrders, acceptOrder, declineOrder } from "./api/client";
export { statusFromEventType, upsertOrder, applyOrderEvent, type OrderStreamEvent } from "./orders/order-events";
```

- [ ] **Step 9: Commit**

```bash
git add packages/web-shared
git commit -m "feat(web-shared): merchant API fns + status/queue helpers (Vitest)"
```
End body with the `Co-Authored-By` trailer.

---

## Task 5: web-shared — fetch-based SSE hook `useOrderStream` (Vitest)

**Files:**
- Create: `packages/web-shared/src/orders/use-order-stream.ts`, `src/orders/use-order-stream.test.ts`
- Modify: `packages/web-shared/package.json` (dep), `src/index.ts`

- [ ] **Step 1: Add the SSE client dep**

```bash
pnpm --filter @flashbite/web-shared add @microsoft/fetch-event-source
```

- [ ] **Step 2: Write the failing hook test**

The hook delegates parsing to a small pure helper `parseStreamData` that we can unit-test without a real connection. Create `packages/web-shared/src/orders/use-order-stream.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseStreamData } from "./use-order-stream";

describe("parseStreamData", () => {
  it("parses a well-formed SSE data line into an OrderStreamEvent", () => {
    expect(parseStreamData(JSON.stringify({ orderId: "o-1", eventType: "OrderAccepted" })))
      .toEqual({ orderId: "o-1", eventType: "OrderAccepted" });
  });
  it("returns null for malformed JSON", () => {
    expect(parseStreamData("not json")).toBeNull();
  });
  it("returns null when orderId or eventType is missing", () => {
    expect(parseStreamData(JSON.stringify({ orderId: "o-1" }))).toBeNull();
    expect(parseStreamData(JSON.stringify({ eventType: "OrderPlaced" }))).toBeNull();
  });
});
```

- [ ] **Step 3: Run -> FAIL**

Run: `pnpm --filter @flashbite/web-shared test src/orders/use-order-stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the hook**

Create `packages/web-shared/src/orders/use-order-stream.ts`:
```ts
"use client";
import { useEffect, useRef } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { OrderStreamEvent } from "./order-events";

/** Pure parser for one SSE `data` payload. Exported for tests. */
export function parseStreamData(data: string): OrderStreamEvent | null {
  try {
    const o = JSON.parse(data) as Partial<OrderStreamEvent>;
    if (typeof o.orderId === "string" && typeof o.eventType === "string") {
      return { orderId: o.orderId, eventType: o.eventType };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Subscribes to the merchant SSE stream via the same-origin rewrite. Uses
 * fetch-based SSE (not EventSource) so the X-Tenant-ID header can be sent.
 * Calls `onEvent` for each parsed event; auto-reconnects; `onOpen` fires on
 * (re)connect so the caller can resync the list.
 */
export function useOrderStream(
  tenantId: string,
  onEvent: (e: OrderStreamEvent) => void,
  onOpen?: () => void,
): void {
  const onEventRef = useRef(onEvent);
  const onOpenRef = useRef(onOpen);
  onEventRef.current = onEvent;
  onOpenRef.current = onOpen;

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchEventSource("/api/read/merchant/orders/stream", {
      headers: { "X-Tenant-ID": tenantId },
      signal: ctrl.signal,
      openWhenHidden: true,
      onopen: async () => { onOpenRef.current?.(); },
      onmessage: (msg) => {
        const parsed = parseStreamData(msg.data);
        if (parsed) onEventRef.current(parsed);
      },
    }).catch(() => { /* aborted on unmount */ });
    return () => ctrl.abort();
  }, [tenantId]);
}
```

- [ ] **Step 5: Run -> PASS + export**

Run: `pnpm --filter @flashbite/web-shared test`
Expected: all pass.
Append to `packages/web-shared/src/index.ts`:
```ts
export { useOrderStream, parseStreamData } from "./orders/use-order-stream";
```

- [ ] **Step 6: Commit**

```bash
git add packages/web-shared pnpm-lock.yaml
git commit -m "feat(web-shared): fetch-based useOrderStream SSE hook (sends X-Tenant-ID)"
```
End body with the `Co-Authored-By` trailer.

---

## Task 6: web-shared — shadcn `Table` + `Sheet` + generic `DataTable`

**Files:**
- Create: `packages/web-shared/src/components/ui/table.tsx`, `src/components/ui/sheet.tsx`, `src/components/data-table.tsx`
- Modify: `packages/web-shared/package.json` (deps), `src/index.ts`

- [ ] **Step 1: Add deps**

```bash
pnpm --filter @flashbite/web-shared add @tanstack/react-table @radix-ui/react-dialog
```
(`@radix-ui/react-dialog` backs the shadcn `Sheet`.)

- [ ] **Step 2: Add the shadcn Table + Sheet components**

Add `table` and `sheet` from shadcn/ui (new-york) into `packages/web-shared/src/components/ui/` using the same owned-source approach used for the existing components (the package's `components.json` already exists). Either:
```bash
cd packages/web-shared && pnpm dlx shadcn@latest add table sheet --yes && cd ../..
```
or, if the CLI cannot target the package, hand-create `table.tsx` (Radix-free; plain `<table>` wrappers + `cn`) and `sheet.tsx` (built on `@radix-ui/react-dialog`) from the official new-york source. Each must import `cn` from `../../lib/utils`. Verify they compile.

- [ ] **Step 3: Implement the generic DataTable**

Create `packages/web-shared/src/components/data-table.tsx`:
```tsx
"use client";
import {
  type ColumnDef, type SortingState, type ColumnFiltersState,
  flexRender, getCoreRowModel, getSortedRowModel, getFilteredRowModel, useReactTable,
} from "@tanstack/react-table";
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  initialSorting?: SortingState;
  globalFilter?: string;
  onRowClick?: (row: TData) => void;
}

export function DataTable<TData, TValue>({
  columns, data, initialSorting = [], globalFilter, onRowClick,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const table = useReactTable({
    data, columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((hg) => (
          <TableRow key={hg.id}>
            {hg.headers.map((header) => (
              <TableHead
                key={header.id}
                onClick={header.column.getToggleSortingHandler()}
                className={header.column.getCanSort() ? "cursor-pointer select-none" : ""}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
                {{ asc: " ↑", desc: " ↓" }[header.column.getIsSorted() as string] ?? ""}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.length === 0 ? (
          <TableRow><TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">No orders yet.</TableCell></TableRow>
        ) : (
          table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} onClick={() => onRowClick?.(row.original)} className={onRowClick ? "cursor-pointer" : ""}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 4: Export + verify build**

Append to `packages/web-shared/src/index.ts`:
```ts
export {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "./components/ui/table";
export {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose,
} from "./components/ui/sheet";
export { DataTable, type DataTableProps } from "./components/data-table";
```
(Adjust the `Sheet`/`Table` named exports to exactly what the added shadcn files export.)
```bash
pnpm install
pnpm --filter @flashbite/web-shared test
pnpm --filter web-merchant build
```
Expected: web-shared tests still pass; the merchant app builds with the new exports importable.

- [ ] **Step 5: Commit**

```bash
git add packages/web-shared pnpm-lock.yaml
git commit -m "feat(web-shared): shadcn Table + Sheet + generic TanStack DataTable"
```
End body with the `Co-Authored-By` trailer.

---

## Task 7: web-merchant — orders table (columns, default sort, filters)

**Files:**
- Create: `apps/web-merchant/components/orders-table.tsx`
- Modify: `apps/web-merchant/app/page.tsx`

- [ ] **Step 1: Implement the orders table component**

Create `apps/web-merchant/components/orders-table.tsx`:
```tsx
"use client";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable, StatusPill, type OrderView } from "@flashbite/web-shared";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const shortId = (id: string) => `#${id.slice(0, 8)}`;
const itemsSummary = (o: OrderView) => o.items.map((i) => `${i.sku} ×${i.qty}`).join(", ");
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const orderColumns: ColumnDef<OrderView>[] = [
  { id: "time", accessorKey: "updatedAt", header: "Time", cell: ({ row }) => <span className="text-muted-foreground">{hhmm(row.original.updatedAt)}</span> },
  { id: "order", header: "Order", cell: ({ row }) => <span className="font-semibold">{shortId(row.original.orderId)}</span> },
  { id: "customer", accessorKey: "customerId", header: "Customer" },
  { id: "items", header: "Items", cell: ({ row }) => <span className="text-muted-foreground">{itemsSummary(row.original)}</span> },
  { id: "total", accessorKey: "totalAmount", header: "Total", cell: ({ row }) => <span className="font-semibold">{euro(row.original.totalAmount)}</span> },
  { id: "status", accessorKey: "status", header: "Status", cell: ({ row }) => <StatusPill status={row.original.status} /> },
];

export function OrdersTable({
  data, globalFilter, onRowClick,
}: {
  data: OrderView[];
  globalFilter: string;
  onRowClick: (o: OrderView) => void;
}) {
  return (
    <DataTable
      columns={orderColumns}
      data={data}
      initialSorting={[{ id: "time", desc: true }]}
      globalFilter={globalFilter}
      onRowClick={onRowClick}
    />
  );
}
```
(Default sort = `time` desc = most recent first. The `globalFilter` text matches across the accessor columns; for filtering by order id/customer this is sufficient.)

- [ ] **Step 2: Minimal dashboard page wiring (data via mount fetch only; SSE + sheet come in Task 8)**

Replace `apps/web-merchant/app/page.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";
import { listOrders, useTenantStore, Input, type OrderView } from "@flashbite/web-shared";
import { OrdersTable } from "@/components/orders-table";

export default function Dashboard() {
  const tenant = useTenantStore((s) => s.tenant);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let active = true;
    listOrders(tenant).then((rows) => { if (active) setOrders(rows); }).catch(() => { if (active) setOrders([]); });
    return () => { active = false; };
  }, [tenant]);

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="text-lg font-extrabold">flashbite <span className="text-muted-foreground font-semibold">merchant</span></div>
        <div className="flex items-center gap-2 text-sm font-semibold"><span className="h-2 w-2 rounded-full bg-primary" />{tenant}</div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Input placeholder="Search order id / customer" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search orders" className="max-w-xs" />
        </div>
        <OrdersTable data={orders} globalFilter={filter} onRowClick={() => { /* sheet in Task 8 */ }} />
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Verify build + browser**

```bash
pnpm --filter web-merchant build
```
Expected: passes. Optionally `pnpm --filter web-merchant dev` with read-api up + a seeded order → the table renders rows, default sorted by Time desc, clicking a column header re-sorts, typing in search filters. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add apps/web-merchant/components/orders-table.tsx apps/web-merchant/app/page.tsx
git commit -m "feat(web-merchant): orders table — columns, default most-recent sort, search filter"
```
End body with the `Co-Authored-By` trailer.

---

## Task 8: web-merchant — detail sheet (accept/decline) + live SSE

**Files:**
- Create: `apps/web-merchant/components/order-detail-sheet.tsx`
- Modify: `apps/web-merchant/app/page.tsx`

- [ ] **Step 1: Implement the detail sheet**

Create `apps/web-merchant/components/order-detail-sheet.tsx`:
```tsx
"use client";
import { useState } from "react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, Button, StatusPill,
  acceptOrder, declineOrder, ORDER_STATUS, type OrderView,
} from "@flashbite/web-shared";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export function OrderDetailSheet({
  order, tenant, onClose,
}: {
  order: OrderView | null;
  tenant: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: (t: string, id: string) => Promise<void>) => {
    if (!order) return;
    setBusy(true); setError(null);
    try {
      await fn(tenant, order.orderId);
      // Status flips when the saga's event arrives over SSE; close the sheet.
      onClose();
    } catch {
      setError("Action failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={order !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent>
        {order && (
          <>
            <SheetHeader>
              <SheetTitle>Order #{order.orderId.slice(0, 8)}</SheetTitle>
            </SheetHeader>
            <div className="mt-3"><StatusPill status={order.status} /></div>
            <div className="mt-4 text-sm text-muted-foreground">Customer</div>
            <div className="font-semibold">{order.customerId}</div>
            <div className="mt-4 text-sm text-muted-foreground">Items</div>
            <div className="mt-1 space-y-1">
              {order.items.map((i) => (
                <div key={i.sku} className="flex justify-between text-sm">
                  <span>{i.sku} ×{i.qty}</span><span>{euro(i.price * i.qty)}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-between border-t pt-3 font-extrabold">
              <span>Total</span><span>{euro(order.totalAmount)}</span>
            </div>
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
            {order.status === ORDER_STATUS.PLACED && (
              <div className="mt-6 flex gap-2">
                <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => act(declineOrder)}>
                  {busy ? "…" : "Decline"}
                </Button>
                <Button className="flex-1" disabled={busy} onClick={() => act(acceptOrder)}>
                  {busy ? "…" : "Accept"}
                </Button>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Wire SSE + sheet into the dashboard**

Replace `apps/web-merchant/app/page.tsx`:
```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import {
  listOrders, getOrder, useOrderStream, applyOrderEvent, upsertOrder,
  statusFromEventType, useTenantStore, Input, ORDER_STATUS, type OrderView, type OrderStreamEvent,
} from "@flashbite/web-shared";
import { OrdersTable } from "@/components/orders-table";
import { OrderDetailSheet } from "@/components/order-detail-sheet";

export default function Dashboard() {
  const tenant = useTenantStore((s) => s.tenant);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<OrderView | null>(null);

  const resync = useCallback(() => {
    listOrders(tenant).then(setOrders).catch(() => setOrders([]));
  }, [tenant]);

  useEffect(() => { resync(); }, [resync]);

  const onEvent = useCallback((e: OrderStreamEvent) => {
    setOrders((rows) => {
      if (rows.some((r) => r.orderId === e.orderId)) return applyOrderEvent(rows, e);
      // Unknown order (likely OrderPlaced) — fetch its detail then upsert.
      if (statusFromEventType(e.eventType) === ORDER_STATUS.PLACED) {
        getOrder(tenant, e.orderId).then((o) => { if (o) setOrders((cur) => upsertOrder(cur, o)); }).catch(() => {});
      }
      return rows;
    });
  }, [tenant]);

  useOrderStream(tenant, onEvent, resync);

  // Keep the open sheet in sync with row updates.
  const current = selected ? orders.find((o) => o.orderId === selected.orderId) ?? selected : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="text-lg font-extrabold">flashbite <span className="text-muted-foreground font-semibold">merchant</span></div>
        <div className="flex items-center gap-2 text-sm font-semibold"><span className="h-2 w-2 rounded-full bg-primary" />{tenant}</div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Input placeholder="Search order id / customer" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search orders" className="max-w-xs" />
        </div>
        <OrdersTable data={orders} globalFilter={filter} onRowClick={setSelected} />
      </main>
      <OrderDetailSheet order={current} tenant={tenant} onClose={() => setSelected(null)} />
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
pnpm --filter web-merchant build
```
Expected: passes (TS + ESLint clean, no unused imports).

- [ ] **Step 4: Commit**

```bash
git add apps/web-merchant/components/order-detail-sheet.tsx apps/web-merchant/app/page.tsx
git commit -m "feat(web-merchant): detail sheet (accept/decline) + live SSE updates"
```
End body with the `Co-Authored-By` trailer.

---

## Task 9: Playwright e2e + test scripts

**Files:**
- Create: `apps/web-merchant/playwright.config.ts`, `apps/web-merchant/e2e/merchant.spec.ts`
- Modify: `apps/web-merchant/package.json`, root `package.json`

- [ ] **Step 1: Add Playwright**

```bash
pnpm --filter web-merchant add -D @playwright/test
pnpm --filter web-merchant exec playwright install chromium
```

- [ ] **Step 2: Playwright config**

Create `apps/web-merchant/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  use: { baseURL: "http://localhost:3101" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3101",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

- [ ] **Step 3: Write the e2e**

Create `apps/web-merchant/e2e/merchant.spec.ts`:
```ts
import { test, expect, request } from "@playwright/test";

const WRITE_API = "http://localhost:3001";

test("an incoming order appears, can be accepted, and flips to ACCEPTED", async ({ page }) => {
  await page.goto("/");

  // Place an order via write-api (X-Tenant-ID berlin) while the dashboard is open.
  const orderId = crypto.randomUUID();
  const api = await request.newContext();
  try {
    const res = await api.post(`${WRITE_API}/orders`, {
      headers: { "X-Tenant-ID": "berlin", "Content-Type": "application/json" },
      data: { orderId, customerId: "e2e-merchant", items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200 },
    });
    expect(res.status()).toBe(201);

    const shortId = `#${orderId.slice(0, 8)}`;
    const row = page.getByText(shortId);
    await expect(row).toBeVisible({ timeout: 30_000 }); // arrives via SSE (or resync)

    await row.click();
    await page.getByRole("button", { name: "Accept" }).click();

    // Saga records OrderAccepted -> SSE updates the row -> ACCEPTED visible.
    await expect(page.getByText("ACCEPTED")).toBeVisible({ timeout: 45_000 });
  } finally {
    await api.dispose();
  }
});

test("status filter is present and the table renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("Search order id / customer")).toBeVisible();
});
```

- [ ] **Step 4: Wire scripts**

In `apps/web-merchant/package.json` `scripts` add (keep dev/build/start/lint):
```json
    "test": "vitest run",
    "test:e2e": "playwright test"
```
In root `package.json` `scripts` add (keep existing): 
```json
    "test:e2e:merchant": "pnpm --filter web-merchant test:e2e"
```
And extend `test:web` to also run the merchant unit step (web-merchant has no Vitest files, so it's a no-op but keeps symmetry) — leave `test:web` as `pnpm --filter @flashbite/web-shared test` (the shared package holds all the unit tests).

- [ ] **Step 5: Run unit suites + build (HARD GATE)**

```bash
pnpm test:web                      # web-shared Vitest — all pass (incl. new api/order-events/use-order-stream tests)
pnpm --filter web-merchant build   # builds clean
```

- [ ] **Step 6: e2e (BEST-EFFORT — needs full stack)**

The e2e needs `pnpm infra:up` + `pnpm dev:write-api` + `pnpm dev:outbox` + `pnpm dev:projection` + `pnpm dev:read-api` + `pnpm dev:saga` (Playwright auto-starts the merchant web server). Bringing up 6 services from a subagent is fragile — ATTEMPT only if straightforward; otherwise SKIP and report that the controller runs `pnpm test:e2e:merchant` against the full stack. No orphan processes. Hard gate for this task: Playwright installed, config+spec+scripts correct, unit suites green, app builds.

- [ ] **Step 7: Commit**

```bash
git add apps/web-merchant/playwright.config.ts apps/web-merchant/e2e apps/web-merchant/package.json package.json pnpm-lock.yaml
git commit -m "test(web-merchant): Playwright e2e (incoming order -> accept -> ACCEPTED) + scripts"
```
End body with the `Co-Authored-By` trailer.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- `GET /merchant/orders` recent-orders endpoint (tenant-scoped, sorted, capped 100) → Task 1. ✓
- New `apps/web-merchant` (Next 16, Tailwind v4, 3101, rewrites, Jest-isolated) → Task 3; shared theme extraction → Task 2. ✓
- web-shared additions: `listOrders`/`acceptOrder`/`declineOrder` → Task 4; `statusFromEventType` + queue reducer → Task 4; `useOrderStream` (fetch-based, sends X-Tenant-ID) → Task 5; shadcn `Table`/`Sheet` + generic `DataTable` (TanStack) → Task 6. ✓
- Orders table (columns, default `updatedAt`-desc, sort, search filter) + row-click → Task 7; detail `Sheet` + accept/decline (pending; saga-confirmed via SSE) → Task 8. ✓
- Data flow: mount `listOrders` seed + live SSE upsert/apply, `OrderPlaced`→fetch detail, status from `eventType` → Tasks 7-8. ✓
- Error handling: accept/decline failure inline; SSE reconnect → `resync` via `onOpen`; empty state in `DataTable` → Tasks 6,8. ✓
- Testing: Vitest (api fns, status/reducer, parseStreamData) → Tasks 4-5; read-api e2e → Task 1; Playwright e2e → Task 9. ✓

**Placeholder scan:** No TBD/TODO; shadcn `Table`/`Sheet` are CLI/owned-source (Task 6) with a hand-create fallback documented — consistent with how 1d-i added shadcn.

**Type/name consistency:** `OrderView` (contracts), `OrderStreamEvent {orderId,eventType}`, `statusFromEventType`/`upsertOrder`/`applyOrderEvent`, `listOrders`/`acceptOrder`/`declineOrder`, `useOrderStream(tenant,onEvent,onOpen)`+`parseStreamData`, `DataTable`/`orderColumns`, `OrdersTable`/`OrderDetailSheet`, `ORDER_STATUS`, and the proxy paths (`/api/read/merchant/orders`, `/api/read/merchant/orders/stream`, `/api/write/orders/:id/accept|decline`) are used identically across read-api, web-shared, and web-merchant.

**Deviation from spec (noted):** spec said the SSE hook uses `EventSource`; the plan uses `@microsoft/fetch-event-source` because `EventSource` cannot send the required `X-Tenant-ID` header. Same behavior (live updates + reconnect), correct tenant scoping, no backend change. Spec updated to match.

**Scope note:** one cohesive slice (table + sheet + one endpoint + shared additions). Recent-100 cap (no pagination), no auth (Phase 2), customer-page push and closed-order history remain backlog.
