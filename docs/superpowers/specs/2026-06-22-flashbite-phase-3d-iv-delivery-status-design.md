# Phase 3d-iv — Delivery status on customer + merchant (design)

**Goal:** Surface the driver-dispatch / delivery progress (`OFFERED → DISPATCHED → PICKED_UP → DELIVERED`, or `FAILED`) on the **customer** order-tracking page and the **merchant** order views, using outward-facing wording.

**Builds on:** Phase 3d-i (the `DriverDispatch` read model + `GET /orders/:orderId/dispatch`) and Phase 3d-ii (the `DispatchStreamService` + `dispatch-events` SSE feeder, and the web-shared `DispatchView`/`DISPATCH_STATUS` exports). Slice **3d-iv** of Phase 3d. Distinct from 3d-iii (customer live driver-location *map*) — this is delivery *status*, not geo.

**Branch:** `phase-3d-iv-delivery-status`, stacked on `phase-3d-ii-driver-job-ui` (it depends on 3d-ii's `DispatchStreamService` + web-shared dispatch exports). **Merge order: land #28 (3d-ii) first**, then this — its PR should be based on `main` once 3d-ii is merged.

## Scope

In scope: a tenant-wide merchant dispatch SSE; a `getOrderDispatch(orderId)` read client; an outward-facing `deliveryStatusLabel`; a `useTenantDispatchStream` hook; a delivery-status line on the customer tracking page (poll) and a delivery column + detail line on the merchant orders UI (live SSE).

Out of scope: customer live driver-location map (3d-iii); admin delivery status; surfacing driver identity (driverId) to customer/merchant; any change to the dispatch workflow, the projection, or the `dispatch-events` feeder (all already in place).

## Architecture & data flow

```
DriverDispatch read model  (Mongo `dispatches`, _id = `<tenant>:<order>`)
  ├─ GET /orders/:orderId/dispatch  (any authed tenant user)        → customer poll (single order)
  └─ DispatchStreamService (per-tenant Subject, fed by dispatch-events; from 3d-ii)
       └─ NEW GET /merchant/dispatch/stream  (@Sse, @Roles MERCHANT) → useTenantDispatchStream()
                                                                       → merchant table + detail sheet
```

Customer keeps its existing poll loop and adds a parallel dispatch poll (single order). Merchant streams the whole tenant's dispatch updates and merges them by `orderId`.

## Backend changes (read-api)

One new endpoint; no feeder/projection change (the `dispatch-events` consumer feeding `DispatchStreamService` already runs from 3d-ii).

- **`GET /merchant/dispatch/stream`** (`@Sse`, `@Roles(MERCHANT)`): subscribes to `DispatchStreamService.stream(currentTenant())` and maps each `DispatchView` to `{ data: view }` — the **whole tenant's** dispatch updates, no per-driver filter (unlike the driver stream). Mirrors `MerchantSseController`'s `merchant/orders/stream`. Lives in a new `MerchantDispatchSseController` (or an added handler on the existing merchant SSE controller); registered in `SseModule` (which already provides `DispatchStreamService`). Tenant isolation holds — the subject is keyed by `currentTenant()` from the verified JWT.

No initial snapshot is needed here (the merchant table loads its orders separately and merges live dispatch updates as they arrive); a merchant opening the detail sheet for an order with no streamed update yet falls back to `getOrderDispatch`.

## web-shared additions (`packages/web-shared`)

- **`getOrderDispatch(orderId)`** (`src/api/client.ts`): GET `/api/read/orders/:orderId/dispatch`, returns `DispatchView | { status: null }`. Bearer via the existing `authedFetch`.
- **`deliveryStatusLabel(status)`** (`src/dispatch/labels.ts`, alongside the driver `dispatchStatusLabel`): outward-facing copy —
  `OFFERED → "Finding a driver"`, `DISPATCHED → "Driver assigned"`, `PICKED_UP → "Out for delivery"`, `DELIVERED → "Delivered"`, `FAILED → "Delivery unavailable"`; unknown → passthrough.
- **`useTenantDispatchStream()`** (`src/dispatch/use-tenant-dispatch-stream.ts`, new): fetch-based SSE (Bearer) against `/api/read/merchant/dispatch/stream`; maintains `Record<orderId, DispatchView>` reconciled by version (reusing `parseDispatchData` and the `reduceDispatch` rule per order). Returns `{ dispatches, connected }`. Auto-reconnect like `useOrderStream`/`useDispatchStream`.

## Customer (`apps/web-customer/app/orders/[orderId]/page.tsx`)

The page already polls `getOrder` (2s, terminal-aware). Add a parallel `getOrderDispatch(orderId)` poll in the same effect; once the order is `ACCEPTED`, render a **Delivery** line: `deliveryStatusLabel(dispatch.status)` (or "Preparing…" when there is no dispatch record yet). Stop dispatch polling when the dispatch is terminal (`DELIVERED`/`FAILED`) or the order is terminal, consistent with the existing poll stop.

## Merchant (`apps/web-merchant`)

- Subscribe once via `useTenantDispatchStream()`; expose the `Record<orderId, DispatchView>` to the table + sheet.
- **Orders table** (`components/orders-table.tsx`): add a **"Delivery"** column rendering `deliveryStatusLabel(dispatches[orderId]?.status)` (or "—" when none) — a small text/badge, consistent with the existing Status column.
- **Detail sheet** (`components/order-detail-sheet.tsx`): add a delivery-status line for the open order from the same map, falling back to `getOrderDispatch(orderId)` on open if the stream hasn't delivered an update yet.

## Error handling

- Customer poll failure → keep last known value, retry next tick (mirrors the existing order poll).
- Merchant SSE drop → hook reconnects (same pattern as `useOrderStream`).
- No dispatch record yet → customer shows "Preparing…", merchant shows "—".

## Testing

- **Vitest (web-shared):** `getOrderDispatch` (URL/method/Bearer + `{status:null}` passthrough); `deliveryStatusLabel` (all five + passthrough); `useTenantDispatchStream` reducer (events keyed by orderId, version-reconciled).
- **read-api:** a unit/integration test that the merchant dispatch stream emits the tenant's `DispatchView`s and is gated to the `merchant` role (mirrors the existing order-stream/driver-stream tests).
- **Playwright:** customer tracking shows a Delivery line after accept; merchant table shows a Delivery column value. (Infra-gated, like the other web e2e.)

## Success criteria

1. A customer on the tracking page sees delivery progress advance (Finding a driver → Driver assigned → Out for delivery → Delivered) without manual refresh (poll).
2. A merchant sees a live **Delivery** column in the orders table and a delivery line in the detail sheet, updating via SSE as the dispatch progresses — and **only** their tenant's data.
3. No driver identity is shown to customer or merchant — status only.
4. web-shared Vitest, read-api tests, typechecks, and the web builds pass; Playwright (infra-gated) covers the new UI.

## Known simplifications (backlog)

- Per-tenant merchant dispatch SSE (no per-merchant/per-order filter — a merchant sees all their tenant's dispatches, which is appropriate for the merchant role).
- Customer uses polling (consistent with its existing order/payment polling) rather than a per-customer dispatch SSE.
- `FAILED` is shown as "Delivery unavailable"; richer recovery messaging (requeue/refund) remains backlog (the order aggregate is still left `ACCEPTED` on dispatch failure — a 3d-i backlog item).
