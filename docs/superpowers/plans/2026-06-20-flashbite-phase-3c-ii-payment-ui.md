# Phase 3c-ii — Payment UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Phase 3c payment state visible in the UI — a customer-facing payment status on the order-tracking page, plus readable cancel-reason labels across customer/merchant/admin views — without copying payment state into the order read model.

**Architecture:** A new read-only path: payments service gains `GET /payments/:tenantId/:orderId`; read-api gains `GET /orders/:orderId/payment` (tenant from JWT, server-to-server to payments via a `PaymentsClient`); frontends call only read-api. web-shared gets a `paymentStatusLabel` helper and a `fetchOrderPayment` client fn. Payments remains the owner of payment state.

**Tech Stack:** NestJS 10.4.4 (payments :3004, read-api :3002), Prisma (payments-owned client), Jest + supertest (backend e2e), Next.js 16 (web-customer/merchant/admin), Vitest (web-shared), `@flashbite/contracts` / `@flashbite/shared` / `@flashbite/web-shared`.

**Branch:** `phase-3c-ii-payment-ui` (already created, stacked on `phase-3c-payments` / PR #23).

---

## File Structure

**New files:**
- (none — all changes extend existing files)

**Modified files:**
- `packages/contracts/src/index.ts` — add `OrderPaymentView` type.
- `apps/payments/src/payments.service.ts` — add `get()`.
- `apps/payments/src/payments.controller.ts` — add `GET /payments/:tenantId/:orderId`.
- `apps/payments/test/payments.e2e-spec.ts` — add GET tests.
- `apps/read-api/src/orders/payments-client.ts` — **new** `PaymentsClient` provider.
- `apps/read-api/src/orders/orders-query.controller.ts` — add `GET /orders/:orderId/payment`.
- `apps/read-api/src/orders/orders.module.ts` — register `PaymentsClient`.
- `apps/read-api/test/order-payment.e2e-spec.ts` — **new** e2e.
- `packages/web-shared/src/orders/order-events.ts` — add `paymentStatusLabel`.
- `packages/web-shared/src/orders/order-events.test.ts` — add label tests.
- `packages/web-shared/src/api/client.ts` — add `fetchOrderPayment` + `OrderPaymentView` re-export.
- `packages/web-shared/src/api/client.test.ts` — add `fetchOrderPayment` test.
- `packages/web-shared/src/index.ts` — export `paymentStatusLabel`, `fetchOrderPayment`, `OrderPaymentView`.
- `apps/web-customer/app/orders/[orderId]/page.tsx` — payment line + cancel-reason label.
- `apps/web-merchant/components/order-detail-sheet.tsx` — cancel-reason label.
- `apps/web-admin/components/admin-orders-table.tsx` — readable cancel-reason label.
- `docs/ARCHITECTURE.md` — short §3c-ii note (payment-status read path).
- `apps/write-api/requests.http` — add the two new GET requests (the repo's only `.http` scratch file).

---

## Task 1: Contracts — `OrderPaymentView`

**Files:**
- Modify: `packages/contracts/src/index.ts` (after the `PaymentResponse` block, ~line 205)
- Test: `packages/contracts/src/contracts.spec.ts` (existing snapshot/assertions)

- [ ] **Step 1: Add the read-side payment view type**

Append to the `// ---- Payments (Phase 3c) ----` section in `packages/contracts/src/index.ts`:

```ts
/** Read-side projection of a payment for the order-tracking UI. `status` is null when no payment exists yet. */
export interface OrderPaymentView {
  status: PaymentStatus | null;
}
```

- [ ] **Step 2: Run the contracts suite to confirm nothing broke**

Run: `pnpm jest packages/contracts -- --silent`
Expected: PASS (pure type addition; if `contracts.spec.ts` asserts an export list, add `OrderPaymentView` is a type-only export so it won't appear in a runtime-key snapshot — no change needed. If the suite fails on an exhaustive value check, it is unrelated to this type.)

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/index.ts
git commit -m "feat(contracts): OrderPaymentView read-side payment type (3c-ii)"
```

---

## Task 2: Payments service — read endpoint

**Files:**
- Modify: `apps/payments/src/payments.service.ts`
- Modify: `apps/payments/src/payments.controller.ts`
- Test: `apps/payments/test/payments.e2e-spec.ts`

- [ ] **Step 1: Write the failing GET e2e tests**

Add to `apps/payments/test/payments.e2e-spec.ts` (inside the existing `describe`, after the last `it`):

```ts
  it("GET returns the payment row for an existing order", async () => {
    const orderId = randomUUID();
    await request(app.getHttpServer())
      .post("/payments/authorize")
      .send({ tenantId: "berlin", orderId, amount: 1200, idempotencyKey: `auth:berlin:${orderId}` })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/payments/berlin/${orderId}`)
      .expect(200);
    expect(res.body).toMatchObject({ orderId, status: "AUTHORIZED", amount: 1200 });
  });

  it("GET returns 404 for an unknown order", async () => {
    await request(app.getHttpServer())
      .get(`/payments/berlin/${randomUUID()}`)
      .expect(404);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm jest apps/payments/test/payments.e2e-spec.ts -- --silent`
Expected: FAIL — the two new tests get 404 (no GET route) / route not found. (Requires `flashbite_payments` DB up: `pnpm infra:up` + `pnpm payments:db:deploy`.)

- [ ] **Step 3: Add `get()` to the service**

In `apps/payments/src/payments.service.ts`, add a method to the `PaymentsService` class (after `void()`):

```ts
  /** Read a payment by natural key. Returns null when none exists (caller maps to 404). */
  async get(tenantId: string, orderId: string): Promise<{ orderId: string; status: PaymentStatus; amount: number } | null> {
    const row = await this.prisma.payment.findUnique({ where: { tenantId_orderId: { tenantId, orderId } } });
    if (!row) return null;
    return { orderId: row.orderId, status: row.status as PaymentStatus, amount: row.amount };
  }
```

`PaymentStatus` is already imported at the top of the file.

- [ ] **Step 4: Add the GET route to the controller**

In `apps/payments/src/payments.controller.ts`, update the imports and add the route:

```ts
import { Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
```

Add inside the `PaymentsController` class:

```ts
  @Get(":tenantId/:orderId")
  async getPayment(@Param("tenantId") tenantId: string, @Param("orderId") orderId: string) {
    const row = await this.payments.get(tenantId, orderId);
    if (!row) throw new NotFoundException(`No payment for ${tenantId}:${orderId}`);
    return row;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm jest apps/payments/test/payments.e2e-spec.ts -- --silent`
Expected: PASS (all tests, including the two new GET tests).

- [ ] **Step 6: Commit**

```bash
git add apps/payments/src/payments.service.ts apps/payments/src/payments.controller.ts apps/payments/test/payments.e2e-spec.ts
git commit -m "feat(payments): GET /payments/:tenantId/:orderId read endpoint (3c-ii)"
```

---

## Task 3: read-api — `PaymentsClient` + order payment endpoint

**Files:**
- Create: `apps/read-api/src/orders/payments-client.ts`
- Modify: `apps/read-api/src/orders/orders-query.controller.ts`
- Modify: `apps/read-api/src/orders/orders.module.ts`
- Test: `apps/read-api/test/order-payment.e2e-spec.ts`

- [ ] **Step 1: Write the `PaymentsClient` provider**

Create `apps/read-api/src/orders/payments-client.ts`:

```ts
import { Injectable } from "@nestjs/common";
import { loadConfig } from "@flashbite/shared";
import type { PaymentStatus } from "@flashbite/contracts";

/**
 * Server-to-server client for the payments service (Phase 3c-ii). read-api is the only
 * caller the frontends reach; payments stays internal. Maps a 404 to `null` so the
 * controller can return `{ status: null }` ("no payment yet") distinctly from an error.
 */
@Injectable()
export class PaymentsClient {
  private readonly baseUrl = loadConfig().paymentsUrl;

  async getPayment(tenantId: string, orderId: string): Promise<{ status: PaymentStatus } | null> {
    const res = await fetch(
      `${this.baseUrl}/payments/${encodeURIComponent(tenantId)}/${encodeURIComponent(orderId)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`payments GET failed: ${res.status}`);
    const body = (await res.json()) as { status: PaymentStatus };
    return { status: body.status };
  }
}
```

- [ ] **Step 2: Write the failing read-api e2e**

Create `apps/read-api/test/order-payment.e2e-spec.ts`:

```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";
import { PaymentsClient } from "../src/orders/payments-client";

describe("read-api order payment (e2e)", () => {
  let app: INestApplication;
  let auth: TestAuth;
  let berlinToken: string;
  let tokyoToken: string;
  const calls: Array<{ tenantId: string; orderId: string }> = [];
  const KNOWN = randomUUID();

  // Fake payments client: keys off the tenantId the controller derives from the JWT,
  // so a tokyo token never sees a berlin payment.
  const fakeClient = {
    async getPayment(tenantId: string, orderId: string) {
      calls.push({ tenantId, orderId });
      if (tenantId === "berlin" && orderId === KNOWN) return { status: "AUTHORIZED" as const };
      return null;
    },
  };

  beforeAll(async () => {
    auth = await createTestAuth();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .overrideProvider(PaymentsClient)
      .useValue(fakeClient)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    berlinToken = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
    tokyoToken = await auth.mint({ tenantId: "tokyo", role: "customer", sub: "c-9" });
  });
  afterAll(async () => { await app.close(); });

  it("returns the payment status for an order with a payment", async () => {
    const res = await request(app.getHttpServer())
      .get(`/orders/${KNOWN}/payment`)
      .set("Authorization", `Bearer ${berlinToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "AUTHORIZED" });
  });

  it("returns { status: null } when there is no payment yet", async () => {
    const res = await request(app.getHttpServer())
      .get(`/orders/${randomUUID()}/payment`)
      .set("Authorization", `Bearer ${berlinToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: null });
  });

  it("is tenant-scoped — a tokyo token never sees a berlin payment", async () => {
    calls.length = 0;
    const res = await request(app.getHttpServer())
      .get(`/orders/${KNOWN}/payment`)
      .set("Authorization", `Bearer ${tokyoToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: null });
    expect(calls.at(-1)).toEqual({ tenantId: "tokyo", orderId: KNOWN }); // JWT tenant, not a path param
  });

  it("rejects with no token (401)", async () => {
    const res = await request(app.getHttpServer()).get(`/orders/${KNOWN}/payment`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run the e2e to verify it fails**

Run: `pnpm jest apps/read-api/test/order-payment.e2e-spec.ts -- --silent`
Expected: FAIL — `GET /orders/:orderId/payment` not found (404 on the success case) / `PaymentsClient` provider not registered (overrideProvider throws "not found"). (Requires Mongo/Redis up from `pnpm infra:up`, like the other read-api e2es.)

- [ ] **Step 4: Add the controller route**

In `apps/read-api/src/orders/orders-query.controller.ts`, update imports and add the route. Note the route is declared **before** `@Get(":orderId")` is irrelevant here because the path segment differs (`:orderId/payment`), but keep it after for readability:

```ts
import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { OrdersQueryService } from "./orders-query.service";
import { PaymentsClient } from "./payments-client";
import { currentTenant } from "../tenant-scope";
import type { OrderView, OrderPaymentView } from "@flashbite/contracts";

@Controller("orders")
export class OrdersQueryController {
  constructor(
    private readonly orders: OrdersQueryService,
    private readonly payments: PaymentsClient,
  ) {}

  @Get(":orderId")
  async get(@Param("orderId") orderId: string): Promise<OrderView> {
    const view = await this.orders.getOrder(orderId);
    if (!view) throw new NotFoundException(`Order ${orderId} not found`);
    return view;
  }

  @Get(":orderId/payment")
  async getPayment(@Param("orderId") orderId: string): Promise<OrderPaymentView> {
    const result = await this.payments.getPayment(currentTenant(), orderId);
    return { status: result?.status ?? null };
  }
}
```

- [ ] **Step 5: Register `PaymentsClient` in the module**

In `apps/read-api/src/orders/orders.module.ts`, add the provider:

```ts
import { Module } from "@nestjs/common";
import { MongoService, RedisService } from "@flashbite/shared";
import { OrdersQueryController } from "./orders-query.controller";
import { MerchantOrdersController } from "./merchant-orders.controller";
import { OrdersQueryService } from "./orders-query.service";
import { PaymentsClient } from "./payments-client";

@Module({
  controllers: [OrdersQueryController, MerchantOrdersController],
  providers: [OrdersQueryService, MongoService, RedisService, PaymentsClient],
})
export class OrdersModule {}
```

- [ ] **Step 6: Run the e2e to verify it passes**

Run: `pnpm jest apps/read-api/test/order-payment.e2e-spec.ts -- --silent`
Expected: PASS (all four tests).

- [ ] **Step 7: Commit**

```bash
git add apps/read-api/src/orders/payments-client.ts apps/read-api/src/orders/orders-query.controller.ts apps/read-api/src/orders/orders.module.ts apps/read-api/test/order-payment.e2e-spec.ts
git commit -m "feat(read-api): GET /orders/:orderId/payment via PaymentsClient (3c-ii)"
```

---

## Task 4: web-shared — `paymentStatusLabel` + `fetchOrderPayment`

**Files:**
- Modify: `packages/web-shared/src/orders/order-events.ts`
- Modify: `packages/web-shared/src/orders/order-events.test.ts`
- Modify: `packages/web-shared/src/api/client.ts`
- Modify: `packages/web-shared/src/api/client.test.ts`
- Modify: `packages/web-shared/src/index.ts`

- [ ] **Step 1: Write the failing label test**

Add to `packages/web-shared/src/orders/order-events.test.ts` (import `paymentStatusLabel` from `./order-events`):

```ts
describe("paymentStatusLabel", () => {
  it("maps known statuses to customer-friendly wording", () => {
    expect(paymentStatusLabel("AUTHORIZED")).toBe("Authorized");
    expect(paymentStatusLabel("CAPTURED")).toBe("Paid");
    expect(paymentStatusLabel("VOIDED")).toBe("Voided");
    expect(paymentStatusLabel("DECLINED")).toBe("Declined");
  });
  it("returns empty string for null/undefined/unknown", () => {
    expect(paymentStatusLabel(null)).toBe("");
    expect(paymentStatusLabel(undefined)).toBe("");
    expect(paymentStatusLabel("WAT")).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @flashbite/web-shared test -- --run order-events`
Expected: FAIL — `paymentStatusLabel is not a function`.

- [ ] **Step 3: Implement `paymentStatusLabel`**

Add to `packages/web-shared/src/orders/order-events.ts` (after `cancelReasonLabel`):

```ts
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  AUTHORIZED: "Authorized",
  CAPTURED: "Paid",
  VOIDED: "Voided",
  DECLINED: "Declined",
};

/** Customer-friendly payment status label. Empty string for null/unknown (render nothing). */
export function paymentStatusLabel(status: string | null | undefined): string {
  return status ? (PAYMENT_STATUS_LABELS[status] ?? "") : "";
}
```

- [ ] **Step 4: Run the label test to verify it passes**

Run: `pnpm --filter @flashbite/web-shared test -- --run order-events`
Expected: PASS.

- [ ] **Step 5: Write the failing `fetchOrderPayment` test**

Add to `packages/web-shared/src/api/client.test.ts` (import `fetchOrderPayment` from `./client`):

```ts
  it("fetchOrderPayment GETs the payment path with Bearer, no X-Tenant-ID", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "AUTHORIZED" }), { status: 200 }));

    const res = await fetchOrderPayment("o-1");

    expect(res).toEqual({ status: "AUTHORIZED" });
    expect(lastUrl()).toBe("/api/read/orders/o-1/payment");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("fetchOrderPayment passes through { status: null }", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: null }), { status: 200 }));
    expect(await fetchOrderPayment("o-2")).toEqual({ status: null });
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @flashbite/web-shared test -- --run client`
Expected: FAIL — `fetchOrderPayment is not a function`.

- [ ] **Step 7: Implement `fetchOrderPayment`**

In `packages/web-shared/src/api/client.ts`, update the contracts import and add the fn after `getOrder`:

```ts
import type { OrderItem, OrderView, OrderPaymentView } from "@flashbite/contracts";
```

```ts
/** GET /orders/:id/payment via the same-origin read proxy. `status` is null when no payment exists yet. */
export async function fetchOrderPayment(orderId: string): Promise<OrderPaymentView> {
  const res = await authedFetch(`/api/read/orders/${encodeURIComponent(orderId)}/payment`);
  if (!res.ok) throw new Error(`fetchOrderPayment failed: ${res.status}`);
  return (await res.json()) as OrderPaymentView;
}
```

- [ ] **Step 8: Update the package barrel exports**

In `packages/web-shared/src/index.ts`:

- Add `OrderPaymentView` to the contracts re-export on line 2:
  ```ts
  export type { OrderItem, OrderView, OrderPaymentView } from "@flashbite/contracts";
  ```
- Add `fetchOrderPayment` to the `./api/client` export block (line ~49):
  ```ts
  export {
    placeOrder, getOrder, fetchOrderPayment, listOrders, acceptOrder, declineOrder,
    reportLocation, getNearbyDrivers,
    getAdminOrders, getAdminDrivers,
    UnauthorizedError,
    type PlaceOrderRequest, type NearbyDriver, type ReportLocationBody, type TenantNearbyDriver,
  } from "./api/client";
  ```
- Add `paymentStatusLabel` to the `./orders/order-events` export (line ~55):
  ```ts
  export { statusFromEventType, upsertOrder, applyOrderEvent, cancelReasonLabel, paymentStatusLabel, type OrderStreamEvent } from "./orders/order-events";
  ```

- [ ] **Step 9: Run the full web-shared suite**

Run: `pnpm --filter @flashbite/web-shared test -- --run`
Expected: PASS (all tests, including the new label + client tests).

- [ ] **Step 10: Commit**

```bash
git add packages/web-shared/src/orders/order-events.ts packages/web-shared/src/orders/order-events.test.ts packages/web-shared/src/api/client.ts packages/web-shared/src/api/client.test.ts packages/web-shared/src/index.ts
git commit -m "feat(web-shared): paymentStatusLabel + fetchOrderPayment (3c-ii)"
```

---

## Task 5: web-customer — payment status + cancel reason on tracking page

**Files:**
- Modify: `apps/web-customer/app/orders/[orderId]/page.tsx`

> **Next.js note:** This app is Next 16 with breaking changes (see `apps/web-customer/AGENTS.md`). Before editing, skim the relevant guide under `apps/web-customer/node_modules/next/dist/docs/`. This task only adds a `fetch` + render to an existing `"use client"` component — no new routing/server constructs.

- [ ] **Step 1: Import the new helpers**

Update the import block at the top of `apps/web-customer/app/orders/[orderId]/page.tsx`:

```ts
import {
  getOrder,
  fetchOrderPayment,
  paymentStatusLabel,
  cancelReasonLabel,
  StatusPill,
  Card,
  CardContent,
  Skeleton,
  Button,
  AuthGate,
  ORDER_STATUS,
  type OrderView,
} from "@flashbite/web-shared";
```

- [ ] **Step 2: Track payment status alongside the order poll**

Add state inside `OrderTrackingContent` (next to the existing `useState` calls):

```ts
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
```

Inside the existing `tick` async function in the polling `useEffect`, after `setOrder(o)` (i.e. when `o` is truthy), also fetch the payment status on the same cadence:

```ts
      if (o) {
        setOrder(o);
        setWaiting(false);
        const p = await fetchOrderPayment(orderId).catch(() => null);
        if (active && p) setPaymentStatus(p.status);
        if (TERMINAL.includes(o.status)) return; // resolved — stop polling
      } else {
```

(The `fetchOrderPayment(orderId)` call replaces nothing; it is inserted between `setWaiting(false)` and the existing `if (TERMINAL...)` line.)

- [ ] **Step 3: Render the payment line and cancel reason**

In the `order && (...)` block, extend the inner `space-y-3` div so it shows the payment label and, when cancelled, the readable reason. Replace the existing block:

```tsx
            {order && (
              <div className="space-y-3" aria-live="polite">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Status</span>
                  <StatusPill status={order.status} />
                </div>
                {paymentStatusLabel(paymentStatus) && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Payment</span>
                    <span className="font-semibold">{paymentStatusLabel(paymentStatus)}</span>
                  </div>
                )}
                {order.status === ORDER_STATUS.CANCELLED && cancelReasonLabel(order.cancelReason) && (
                  <p className="text-sm text-destructive">{cancelReasonLabel(order.cancelReason)}</p>
                )}
                {!isTerminal && !stopped && (
                  <p className="text-sm text-muted-foreground">
                    Waiting for the merchant… (saga SLA timer running)
                  </p>
                )}
              </div>
            )}
```

- [ ] **Step 4: Typecheck the app**

Run: `pnpm --filter web-customer exec tsc --noEmit`
Expected: PASS (no type errors). If the app has no `tsc` available, run `pnpm --filter web-customer build` and expect a clean build.

- [ ] **Step 5: Commit**

```bash
git add apps/web-customer/app/orders/[orderId]/page.tsx
git commit -m "feat(web-customer): payment status + cancel reason on tracking page (3c-ii)"
```

---

## Task 6: Cancel-reason label wiring — merchant + admin

**Files:**
- Modify: `apps/web-merchant/components/order-detail-sheet.tsx`
- Modify: `apps/web-admin/components/admin-orders-table.tsx`

> **Next.js note:** Both are `"use client"` components in Next 16 apps; this task only swaps a raw reason string for the `cancelReasonLabel(...)` helper.

- [ ] **Step 1: Merchant detail sheet — show the readable reason on cancelled orders**

In `apps/web-merchant/components/order-detail-sheet.tsx`, add `cancelReasonLabel` to the import:

```ts
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, Button, StatusPill,
  acceptOrder, declineOrder, cancelReasonLabel, ORDER_STATUS, type OrderView,
} from "@flashbite/web-shared";
```

Then render the reason under the status pill. Replace the status line:

```tsx
            <div className="mt-3 flex items-center gap-2">
              <StatusPill status={order.status} />
              {order.status === ORDER_STATUS.CANCELLED && cancelReasonLabel(order.cancelReason) && (
                <span className="text-xs text-muted-foreground">{cancelReasonLabel(order.cancelReason)}</span>
              )}
            </div>
```

- [ ] **Step 2: Admin orders table — use the readable label**

In `apps/web-admin/components/admin-orders-table.tsx`, import the helper and use it in the status cell. Update the import:

```ts
import { DataTable, StatusPill, cancelReasonLabel, type ColumnDef, type OrderView } from "@flashbite/web-shared";
```

Replace the status column cell:

```tsx
  {
    id: "status", accessorKey: "status", header: "Status",
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <StatusPill status={row.original.status} />
        {cancelReasonLabel(row.original.cancelReason) ? (
          <span className="text-xs text-muted-foreground">{cancelReasonLabel(row.original.cancelReason)}</span>
        ) : null}
      </span>
    ),
  },
```

- [ ] **Step 3: Typecheck both apps**

Run: `pnpm --filter web-merchant exec tsc --noEmit && pnpm --filter web-admin exec tsc --noEmit`
Expected: PASS for both. (If `tsc` is unavailable in an app, run that app's `build` instead and expect success.)

- [ ] **Step 4: Commit**

```bash
git add apps/web-merchant/components/order-detail-sheet.tsx apps/web-admin/components/admin-orders-table.tsx
git commit -m "feat(web-merchant,web-admin): readable cancel-reason label (3c-ii)"
```

---

## Task 7: Docs + full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `apps/write-api/requests.http` (the repo's single `.http` scratch file)

- [ ] **Step 1: Document the payment-status read path**

In `docs/ARCHITECTURE.md`, under the §3c payments section, add a short "3c-ii — Payment UI" note:

```markdown
### 3c-ii — Payment UI (read-only)

The customer tracking page shows payment progress without copying payment state into
the order read model. read-api exposes `GET /orders/:orderId/payment` (tenant from the
JWT), which calls the payments service server-to-server (`GET /payments/:tenantId/:orderId`)
and returns `{ status }` or `{ status: null }`. Frontends never call payments directly.
Cancelled orders render a readable reason ("Payment failed" / "SLA breach" /
"Declined by merchant") via the shared `cancelReasonLabel` helper.
```

Data flow:

```
web-customer tracking
  -> GET /api/read/orders/:id           (order status, polled)
  -> GET /api/read/orders/:id/payment   (payment status, polled)
read-api  -> GET payments :3004 /payments/{tenant}/{order}
          -> flashbite_payments ledger
```

- [ ] **Step 2: Add the new requests to `apps/write-api/requests.http`**

```http
### Order payment status (customer/merchant token)
GET http://localhost:3002/orders/{{orderId}}/payment
Authorization: Bearer {{token}}

### Payment row (internal — payments service)
GET http://localhost:3004/payments/{{tenant}}/{{orderId}}
```

- [ ] **Step 3: Run the affected backend suites**

Run (infra up first: `pnpm infra:up && pnpm payments:db:deploy`):
```bash
pnpm jest apps/payments apps/read-api -- --silent
```
Expected: PASS — payments e2e (incl. new GET) and read-api e2e (incl. `order-payment.e2e-spec.ts`).

- [ ] **Step 4: Run the web-shared suite**

Run: `pnpm --filter @flashbite/web-shared test -- --run`
Expected: PASS.

- [ ] **Step 5: Typecheck the three touched frontends**

Run:
```bash
pnpm --filter web-customer exec tsc --noEmit
pnpm --filter web-merchant exec tsc --noEmit
pnpm --filter web-admin exec tsc --noEmit
```
Expected: PASS for all three (or clean `build` where `tsc` is unavailable).

- [ ] **Step 6: Commit**

```bash
git add docs/ARCHITECTURE.md apps/write-api/requests.http
git commit -m "docs: payment-status read path + requests (3c-ii)"
```

---

## Manual smoke test (optional, after merge of #23)

With the full plane running (`infra:up`, `register:schemas`, all five order-plane workers + `dev:payments` + `dev:read-api` + `dev:web-customer`):

1. Place a normal order as a customer → tracking page shows **Payment: Authorized**, then **Payment: Paid** once the merchant accepts (capture).
2. Place an order at/above `AUTH_DECLINE_THRESHOLD` → tracking shows **CANCELLED** with **Payment failed**.
3. Let an order breach SLA → **CANCELLED** with **SLA breach**; payment voided.
4. Merchant declines an order → **CANCELLED** with **Declined by merchant**.

---

## Self-review checklist (controller runs before dispatch)

- **Spec coverage:** (A) customer payment line → Task 5; (C) cancel-reason wiring → Tasks 5/6; read-api endpoint → Task 3; payments read endpoint → Task 2; web-shared helpers → Task 4; payment NOT in read model → confirmed (read-api fetches live); frontends never call payments directly → confirmed (PaymentsClient is server-side). ✓
- **Type consistency:** `OrderPaymentView { status: PaymentStatus | null }` defined in Task 1, consumed in Tasks 3 (`Promise<OrderPaymentView>`), 4 (`fetchOrderPayment`), 5 (render). `PaymentsClient.getPayment` returns `{ status: PaymentStatus } | null` in Task 3, overridden by the same shape in the e2e fake. ✓
- **No placeholders:** every code/test step has full content. ✓
