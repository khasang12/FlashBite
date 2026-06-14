# FlashBite Phase 1d-ii — Merchant Dashboard (Design Spec)

**Date:** 2026-06-14
**Status:** Approved (pending spec review)
**Slice:** Second of four Phase 1d frontend slices. Builds on 1d-i's `packages/web-shared`.

## Goal

A merchant-facing dashboard: a live **orders table** (TanStack Table — sortable columns,
status + text filters, default most-recent first) where clicking a row opens a **detail
side panel** with **Accept / Decline** actions that signal the Temporal saga. New orders and
status changes stream in live over SSE.

## Phase 1d slice context

| Slice | Surface | Status |
|------|---------|--------|
| 1d-i | Customer storefront + shared foundation | done (merged) |
| **1d-ii (this)** | Merchant dashboard | this spec |
| 1d-iii | Driver view (GPS emit + nearby) | later |
| 1d-iv | Admin grid (cross-tenant) — will reuse the shared `DataTable` | later |

## Scope

**In:** a new `apps/web-merchant` app; a read-api `GET /merchant/orders` list endpoint; a
reusable shared `DataTable` (TanStack) + shadcn `Table`/`Sheet`; an `EventSource` SSE hook;
`listOrders`/`acceptOrder`/`declineOrder` API client functions; the orders table (sort/filter,
default most-recent) with a row-click detail sidebar and Accept/Decline.

**Out (later / other slices):** auth/JWT (Phase 2); pagination/infinite scroll (a recent-N
cap is used instead); closed-order history beyond the recent window; the customer push/SSE
channel (separate backlog item); driver/admin surfaces.

## Backend findings this builds on (verified)

- **SSE feed**: `GET /merchant/orders/stream` (read-api, tenant-scoped via `X-Tenant-ID`),
  fed by Kafka `order-events` with `fromBeginning: false` → **live-only, no backfill**. Each
  message is `{ orderId, eventType, status }` where `eventType` ∈ `OrderPlaced` / `OrderAccepted`
  / `OrderCancelled` is the real signal and `status` is hardcoded to `PLACED` in the feeder
  (a simplification). The dashboard derives status **client-side from `eventType`**.
- **Accept/decline**: `POST /orders/:id/accept` and `/decline` (write-api, `X-Tenant-ID`,
  no body) → 202 `{ orderId, signalled }`; signals the saga `merchantApproval`. 404 if the
  workflow is gone.
- **Order detail**: `GET /orders/:id` → `OrderView { tenantId, orderId, customerId, items[],
  totalAmount, status, version, updatedAt }`.
- No "list orders" endpoint exists yet — this slice adds one.

## Architecture

- **`apps/web-merchant`** — Next.js (App Router, TypeScript, Tailwind v4). Dev on **3101**.
  Reuses `@flashbite/web-shared`. Same `next.config` rewrites proxy as web-customer
  (`/api/write/*`→:3001, `/api/read/*`→:3002) and the same root-Jest isolation
  (`testPathIgnorePatterns` for `apps/web-merchant`). Root script `dev:web-merchant`.
- **read-api `GET /merchant/orders`** — returns the tenant's **recent orders across all
  statuses** as `OrderView[]`, from the Mongo read model, sorted `updatedAt` desc and capped
  to **100** (most recent). Tenant-scoped via `getTenantId()`. (Client re-sorts/filters via
  TanStack; the cap bounds payload size.)
- **`packages/web-shared` additions:**
  - shadcn **`Table`** + **`Sheet`** components (added via the same owned-source approach as
    the existing shadcn set).
  - A generic **`DataTable`** wrapper over **`@tanstack/react-table`** (column defs in, sorted/
    filterable table out) — reusable by the admin grid (1d-iv).
  - API client: `listOrders(tenant): OrderView[]`, `acceptOrder(tenant, id)`, `declineOrder(tenant, id)`.
  - `useOrderStream(tenant)` — opens `EventSource('/api/read/merchant/orders/stream')`, yields
    parsed `{ orderId, eventType }` events; closes on unmount; consumers re-sync on reconnect.
  - A pure `statusFromEventType(eventType)` helper (`OrderPlaced`→PLACED, `OrderAccepted`→
    ACCEPTED, `OrderCancelled`→CANCELLED).

## Components & screens (`apps/web-merchant`)

- **`/` (dashboard)** — header (brand + "Live" indicator + tenant), filter bar (text search +
  status `Select`), the orders `DataTable`, and the detail `Sheet`.
- **`MerchantOrdersTable`** — `DataTable` with columns: Time (`updatedAt`), Order (short id),
  Customer, Items (summary), Total (euros), Status (`StatusPill`). **Default sort: `updatedAt`
  desc.** Sortable: Time, Total, Status. Filters: free-text (order id / customer) + status.
  Row click → selects the order (opens the sheet).
- **`OrderDetailSheet`** — shadcn `Sheet`; shows customer, line items, total, `StatusPill`.
  Accept/Decline buttons (with a pending state) render **only when `status === PLACED`**;
  resolved orders are read-only.

## Data flow

- **Mount:** `GET /api/read/merchant/orders` (tenant header) → seed table rows; then open the
  SSE via `useOrderStream`.
- **Live updates:** on `OrderPlaced` for an unknown id → `getOrder(id)` → prepend row; on
  `OrderAccepted`/`OrderCancelled` → update that row's status in place (via
  `statusFromEventType`). Rows are keyed/deduped by `orderId` (upsert).
- **Actions:** row click opens the `Sheet`. Accept/Decline → `POST /api/write/orders/:id/
  accept|decline` (X-Tenant-ID) → 202 → buttons show pending; the saga's resulting
  `OrderAccepted`/`OrderCancelled` arrives over SSE and updates the row + sheet (saga is the
  source of truth — no optimistic status flip).

## Error handling

- Accept/decline failure (incl. 404 workflow-gone) → clear pending, inline error in the sheet.
- SSE disconnect → `EventSource` auto-reconnects; on (re)connect re-run `GET /merchant/orders`
  to resync any events missed while disconnected.
- Mount list fetch failure → retry affordance; explicit empty state when there are no orders.

## Testing

- **Vitest (`web-shared`)**: `listOrders`/`acceptOrder`/`declineOrder` request shape +
  `X-Tenant-ID` header + proxy paths; `statusFromEventType` mapping; the table row
  upsert/dedupe-by-orderId reducer and the default `updatedAt`-desc comparator.
- **read-api e2e (`.e2e-spec.ts`, root Jest)**: `GET /merchant/orders` returns the tenant's
  recent orders, tenant-scoped (a tokyo order is absent from berlin's list), capped/sorted.
- **Playwright e2e (`apps/web-merchant`)**: place an order (write-api) → it appears as the
  top row → click it → Accept → row + sheet flip to ACCEPTED (saga running); plus a
  status-filter assertion. Auto-starts the merchant dev server; backends run separately.

## Open assumptions

- Tenant via `X-Tenant-ID` (no auth until Phase 2); a tenant switcher mirrors the storefront.
- The dashboard shows the **recent 100** orders (read model) + live SSE; older history and
  pagination are out of scope.
- Status is derived from SSE `eventType` (the feeder's hardcoded `status` is ignored);
  fixing the feeder to emit the real status is a small backend cleanup noted for the backlog.
- The shared `DataTable` is built generic enough for the admin grid (1d-iv) to reuse.
