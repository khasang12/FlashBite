# Phase 3c-ii — Payment UI (design)

**Status:** approved (brainstorm) — ready for implementation plan
**Date:** 2026-06-20
**Builds on:** Phase 3c (payments service + authorize/capture/void + `PAYMENT_FAILED`). Stacks on branch `phase-3c-payments` (PR #23).

## Goal

Make the Phase 3c payment work visible in the UI. Today 3c is entirely backend — the
`payments` service has no read endpoint, the order read model carries no payment status, and the
`cancelReasonLabel` helper added in 3c is wired into nothing. This slice adds:

- **(A)** a customer-facing **payment status** on the order-tracking page (Authorized → Captured, or
  Failed), via a new read-only path through read-api; and
- **(C)** wiring the readable **cancel-reason label** (incl. "Payment failed") into the
  customer/merchant/admin order views.

Read-only. No refund/retry actions, no payment in the order read model, no admin payments dashboard.

## Decisions (locked during brainstorm)

1. **A + C** (customer payment status line + cancel-reason label wiring). Not B (admin payments
   dashboard — backlog).
2. **Separate read endpoint** `GET /orders/:orderId/payment` on read-api (not baked into the order
   `GET`), so the order read stays fast and the bounded contexts stay decoupled.
3. **Payment status is NOT added to the Mongo order read model** — read-api fetches it live from the
   payments service. Payments remains the owner of payment state (3c decision preserved).
4. Frontends never call the payments service directly — only read-api, which is server-to-server to
   payments.

## Current state

- `payments` service (`apps/payments`, :3004): only `POST authorize|capture|void`. No GET.
- `OrderView` (`@flashbite/contracts`): has `cancelReason?` but no payment field.
- read-api `GET /orders/:id`: returns `OrderView` (Mongo + Redis cache-aside), tenant-scoped via JWT.
- `cancelReasonLabel` exists in `@flashbite/web-shared` (3c T10) but is **used nowhere**.
- web-customer order-tracking page polls `GET /orders/:id` until terminal status.

## Architecture / data flow

```
web-customer tracking ──/api/read/orders/:id/payment──► read-api
                                                          │  (tenant from JWT)
                                                          └─ GET payments :3004 /payments/{tenant}/{order}
                                                                 └─ flashbite_payments ledger
```

read-api translates the payments service's row into `{ status } | null`; the customer page maps
`status` to a label. The order `GET` is unchanged.

## Backend

### payments service — read endpoint
`GET /payments/:tenantId/:orderId` → `200 { orderId, status, amount }` where `status ∈
{AUTHORIZED, CAPTURED, VOIDED, DECLINED}`, or `404` if no payment row. A thin `PaymentsService.get`
(`findUnique` by the existing `(tenantId, orderId)` unique). Internal (no JWT), like the existing
endpoints.

### read-api — order payment endpoint
- A small `PaymentsClient` provider in read-api (HTTP, reads `config.paymentsUrl`):
  `getPayment(tenantId, orderId): Promise<{ status: string } | null>` — `GET`s the payments service;
  maps `404` → `null`; non-2xx (other than 404) throws.
- `GET /orders/:orderId/payment` (a new route; tenant from the JWT via the existing auth context,
  same `@Roles`/access posture as `GET /orders/:id` — authenticated, tenant-scoped). Returns
  `{ status: PaymentStatus } | { status: null }` (200 with `status: null` when there's no payment yet,
  so the client distinguishes "no payment" from an error). Uses the `tenant-scope` chokepoint for the
  tenantId (no cross-tenant access).

(No Redis caching for payment status — it's a small, fast lookup and changes through the order
lifecycle; keep it simple.)

## Frontend

### web-shared
- `paymentStatusLabel(status: string | null | undefined): string` — maps `AUTHORIZED`→"Authorized",
  `CAPTURED`→"Paid", `VOIDED`→"Voided", `DECLINED`→"Declined"; null/unknown→"" (customer-friendly
  wording). Exported from the package index.
- API client fn `fetchOrderPayment(orderId): Promise<{ status: string | null }>` hitting
  `/api/read/orders/:orderId/payment` via the existing `authedFetch` (Bearer + 401→logout).
- Vitest for both.

### web-customer — payment status (A)
On the order-tracking page (already polling the order), also fetch `fetchOrderPayment(orderId)` on the
same cadence and render a **payment line/badge** beneath the status: e.g. "Payment: Authorized" →
"Payment: Captured", or "Payment: Failed" on a `PAYMENT_FAILED` cancellation, or hidden/"—" when no
payment yet. Reuse the existing badge/pill styling.

### Cancel-reason label wiring (C)
Wire `cancelReasonLabel(order.cancelReason)` into the cancelled-order display in:
- **web-customer** tracking (next to the CANCELLED status),
- **web-merchant** order detail sheet (and/or table row),
- **web-admin** orders table.
So a cancelled order shows "Payment failed" / "SLA breach" / "Declined by merchant" instead of a raw
code or nothing.

## Testing

- **payments** e2e: `GET /payments/:tenantId/:orderId` returns the row for an existing payment and
  `404` for an unknown order.
- **read-api** e2e: `GET /orders/:orderId/payment` returns `{status}` for an order with a payment,
  `{status: null}` when none, and is tenant-scoped (a different tenant's order → null/no leak).
- **web-shared** Vitest: `paymentStatusLabel` mapping; `fetchOrderPayment` request shape (Bearer);
  `cancelReasonLabel` already tested in 3c.
- web-component rendering of the payment badge + cancel-reason label: light unit/Vitest where the
  components are testable; Playwright e2e is backlog.

## Scope boundary / backlog

- Admin payments dashboard (option B).
- Refund/retry actions or any payment mutation from the UI.
- Payment status in the order read model / payment timeline/history.
- Real-time payment updates via SSE (the tracking page polls).

## Success criteria

1. A customer placing an order sees its payment progress (Authorized → Captured) and, on a declined
   order, "Payment failed" — all on the existing tracking page.
2. read-api exposes `GET /orders/:orderId/payment` (tenant-scoped) backed by a payments-service read
   endpoint; frontends never call payments directly.
3. Cancelled orders across customer/merchant/admin show the readable cancel reason via
   `cancelReasonLabel`.
4. Payment state stays owned by the payments service (not copied into the order read model).
5. New tests green (payments GET, read-api payment endpoint, web-shared helpers); existing suites
   unaffected.
