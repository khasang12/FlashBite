# Phase 3c-iii — Customer payment confirmation (design)

**Status:** approved (brainstorm) — ready for implementation plan
**Date:** 2026-06-21
**Builds on:** Phase 3c (payments service + saga authorize/capture/void) and 3c-ii (payment-status read path + labels). Branch will stack on `phase-3c-ii-payment-ui` (PR #24).

## Goal

Insert an interactive **customer "Confirm payment"** gate before authorization. Today payment is fully
automatic: on `OrderPlaced` the saga immediately authorizes, then races the SLA timer against the
merchant's accept/decline. This slice makes the customer explicitly confirm payment first; the saga
**waits** for that confirmation before authorizing, and auto-cancels the order if it never comes.

This is a real behavior change to the happy path, not an additive read-only feature (contrast 3c-ii).

## Decisions (locked during brainstorm)

1. **Gate authorization** (not capture, not a standalone "pay now"). The saga waits for a customer
   confirm signal before running `authorizePaymentActivity`.
2. **No new order status, but the merchant is read-only until payment is authorized.** The order is
   `PLACED` from the start (no `AWAITING_PAYMENT` status). The merchant can always *see* the order,
   but **cannot accept/decline until the order's payment is `AUTHORIZED`** (i.e. the customer has
   confirmed and authorization succeeded). Enforced in two places:
   - **Authoritative:** the write-api accept/decline endpoint rejects with `409 Conflict` when the
     order has no authorized payment yet.
   - **UX:** the merchant detail sheet disables the Accept/Decline buttons and shows "Awaiting
     customer payment" until the payment is authorized (it reads payment status from the 3c-ii
     `GET /orders/:id/payment` endpoint).
   This avoids a dedicated order status while still preventing a merchant from acting on an unpaid
   order. (Payment status drives the gate, not the order read model.)
3. **Separate confirm window + new cancel reason.** A dedicated `PAYMENT_CONFIRM_TIMEOUT_SECONDS`
   (default 120). No confirm in time → `OrderCancelled(PAYMENT_TIMEOUT)` (label "Payment not
   confirmed"). After a successful confirm, the existing `SAGA_SLA_SECONDS` merchant timer starts
   fresh. The two waits are distinct.
4. Confirmation has **no card form** — the PSP is simulated (deterministic amount-based decline), so
   "Confirm payment" is a single button on the known `totalAmount`.

## Current state (what 3c-iii changes)

`apps/saga-worker/src/workflows.ts` (`orderLifecycleWorkflow`):
```ts
const { authorized } = await authorizePaymentActivity(...);   // immediate, no customer gate
if (!authorized) { recordOrderCancelled(PAYMENT_FAILED); return CANCELLED_PAYMENT_FAILED; }
const signalledInTime = await condition(() => approved !== undefined, `${slaSeconds}s`);
// accept -> capture; decline/sla -> void
```
The workflow defines only `merchantApprovalSignal` (`ORDER_SAGA.MERCHANT_APPROVAL_SIGNAL`). The
starter (`apps/saga-worker/src/main.ts`) starts the workflow with
`args: [{ tenantId, orderId, totalAmount, slaSeconds }]` (slaSeconds from `config.sagaSlaSeconds`).
write-api signals merchant accept/decline via `apps/write-api/src/orders/accept.controller.ts`
(`handle.signal(ORDER_SAGA.MERCHANT_APPROVAL_SIGNAL, approved)`; 404 if no active workflow).
`ORDER_STATUS = { PLACED, ACCEPTED, CANCELLED }`. There is no customer payment action anywhere.

## New saga shape

```
OrderPlaced -> workflow starts
  setHandler(confirmPaymentSignal), setHandler(merchantApprovalSignal)
  await confirmPayment, up to confirmSeconds
    |- timeout (not confirmed) -> recordOrderCancelled(PAYMENT_TIMEOUT) -> CANCELLED_PAYMENT_TIMEOUT
    \- confirmed -> authorizePaymentActivity
                     |- declined   -> recordOrderCancelled(PAYMENT_FAILED) -> CANCELLED_PAYMENT_FAILED
                     \- authorized -> [UNCHANGED from 3c] await merchantApproval up to slaSeconds
                                        accept      -> capture -> recordOrderAccepted -> ACCEPTED
                                        decline     -> void -> recordOrderCancelled(DECLINED) -> CANCELLED_DECLINED
                                        sla breach  -> void -> recordOrderCancelled(SLA_BREACH) -> CANCELLED_SLA
```

The workflow stays deterministic — the new wait is a `condition()` + signal handler; all I/O remains
in activities; the only new bundle import is the `ORDER_SAGA` / contracts constants already imported.

## Components

### contracts (`@flashbite/contracts`)
- `ORDER_SAGA.CONFIRM_PAYMENT_SIGNAL: "confirmPayment"`.
- `ORDER_CANCEL_REASONS.PAYMENT_TIMEOUT: "PAYMENT_TIMEOUT"`.
- `ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_TIMEOUT: "CANCELLED_PAYMENT_TIMEOUT"`.
- (pure constant additions — no runtime deps)

### shared config (`packages/shared/src/config.ts`)
- `paymentConfirmTimeoutSeconds: Number(env.PAYMENT_CONFIRM_TIMEOUT_SECONDS ?? 120)` on
  `AppConfig`/`loadConfig`. `.env.example`: add `PAYMENT_CONFIRM_TIMEOUT_SECONDS`.

### saga-worker
- `workflows.ts`: `confirmPaymentSignal = defineSignal(ORDER_SAGA.CONFIRM_PAYMENT_SIGNAL)`; a
  `confirmed` flag + handler; `await condition(() => confirmed, `${args.confirmSeconds}s`)` before
  authorize. If it times out → `recordOrderCancelledActivity(PAYMENT_TIMEOUT)` → return
  `CANCELLED_PAYMENT_TIMEOUT`. `OrderLifecycleArgs` gains `confirmSeconds: number`.
- `main.ts`: pass `confirmSeconds: config.paymentConfirmTimeoutSeconds` in the workflow `args`.

### write-api
- `apps/write-api/src/orders/accept.controller.ts` (or a sibling controller): add
  `POST /orders/:orderId/confirm-payment` (`@Roles(ROLES.CUSTOMER)`, `@HttpCode(202)`) that signals
  `handle.signal(ORDER_SAGA.CONFIRM_PAYMENT_SIGNAL)` on workflow `${tenantId}:${orderId}`, mapping a
  "not found" to `404` (same pattern as accept/decline — covers the brief OrderPlaced→saga-start
  race; the UI retries). Tenant from the JWT. Returns `{ orderId, signalled: "confirm-payment" }`.
- **Accept/decline payment gate (authoritative).** Before signaling `MERCHANT_APPROVAL_SIGNAL`, the
  accept/decline handlers verify the order's payment is `AUTHORIZED`; if not, throw
  `409 Conflict` ("Order payment not confirmed"). This requires a small payments status lookup in
  write-api: a thin `PaymentsClient.getStatus(tenantId, orderId)` (HTTP `GET {paymentsUrl}/payments/
  {tenant}/{order}`, 404 → null) reading `loadConfig().paymentsUrl` — mirrors read-api's 3c-ii
  `PaymentsClient`. (A `CAPTURED`/`VOIDED`/`DECLINED`/absent payment is not `AUTHORIZED`, so the gate
  also blocks acting on an already-terminal order — consistent with today's workflow guards.)

### web-shared
- `confirmPayment(orderId): Promise<void>` in `api/client.ts` — `POST /api/write/orders/:id/confirm-payment`
  via `authedFetch` (mirrors `acceptOrder`/`declineOrder`). Exported from the barrel.
- `cancelReasonLabel` (in `orders/order-events.ts`, `CANCEL_REASON_LABELS`): add
  `PAYMENT_TIMEOUT → "Payment not confirmed"`.
- Vitest for the `confirmPayment` request shape (Bearer, no `X-Tenant-ID`, correct path) and the new
  label mapping.

### web-customer — tracking page
- "Awaiting confirmation" is derived: order `status === PLACED` **and** payment `status === null`
  (deterministic in this design — the saga won't authorize until confirm, so the payment row stays
  absent). In that state, render a prominent **"Confirm payment €X.XX"** button (amount from
  `order.totalAmount`, formatted in euros like the rest of the UI).
- On click: call `confirmPayment(orderId)`, disable the button + show a pending state; the existing
  poll then surfaces **Payment: Authorized** (3c-ii line) on success, or **Payment failed** /
  **Payment not confirmed** on the cancel paths.
- Errors (e.g. 404 before the workflow exists, or a network failure) show a small inline message and
  re-enable the button so the customer can retry.

### web-merchant — read-only until paid
- The order detail sheet (`apps/web-merchant/components/order-detail-sheet.tsx`) fetches the order's
  payment status (via `fetchOrderPayment` from web-shared, the 3c-ii client) when opened. While the
  payment is not `AUTHORIZED`, the **Accept/Decline buttons are hidden/disabled** and the sheet shows
  "Awaiting customer payment". Once `AUTHORIZED`, the buttons enable as today. The orders table stays
  read-only regardless (it already only displays rows). If a stale UI does fire accept/decline, the
  write-api `409` is the backstop and the sheet surfaces the error.

## Required updates to existing behavior/tests (the ripple)

- **3c saga e2e** (`apps/saga-worker/test/*` — accept / decline-SLA / payment-failed) assume immediate
  authorization. Each must now **send the confirm signal first** (via a workflow handle) before the
  merchant signal / SLA, or they'll hit the new `PAYMENT_TIMEOUT` path. Add a new case:
  **no-confirm → `PAYMENT_TIMEOUT` cancel, no payment row created**.
- **Playwright e2e** that place an order and expect it to progress (web-customer tracking,
  web-merchant accept/decline flows) must insert a **confirm-payment** step after placing, else the
  order auto-cancels — and the merchant accept now only works *after* that confirm (the buttons are
  disabled and the endpoint 409s before payment is authorized). Update those flows.
- **write-api accept e2e** (`apps/write-api/test/accept.e2e-spec.ts`): existing accept/decline cases
  now need an authorized payment first (or assert the new `409` when none exists). Add a case:
  accept with no authorized payment → `409`.
- **contracts spec** (`contracts.spec.ts`): extend assertions for the new constants (no weakening).
- Docs: `docs/ARCHITECTURE.md` §3 saga description + the lifecycle diagram gain the confirm gate;
  `apps/write-api/requests.http` gains a confirm-payment request.

## Testing

- **saga-worker e2e (Temporal + payments):** confirm→authorize→accept→`OrderAccepted`+`CAPTURED`;
  confirm→authorize(declined amount)→`OrderCancelled(PAYMENT_FAILED)`; confirm→decline/SLA→`void`;
  **no-confirm→`OrderCancelled(PAYMENT_TIMEOUT)` with no payment row**. Use a short
  `confirmSeconds`/`slaSeconds` via `TestWorkflowEnvironment.createTimeSkipping`.
- **write-api e2e:** `POST /orders/:id/confirm-payment` signals the workflow (200/202), is role-gated
  to customer (403 for others), tenant-scoped, and 404s when no workflow exists. **Accept/decline gate:**
  accept/decline with no authorized payment → `409`; with an authorized payment → `202` as before.
- **web-shared vitest:** `confirmPayment` request shape.
- **web-customer:** light render/logic test that the confirm button appears only when `PLACED` +
  payment `null` and calls `confirmPayment`; Playwright flow updated.

## Scope boundary / backlog

- No card/payment-method entry (simulated PSP).
- No `AWAITING_PAYMENT` order status / merchant gating on payment (explicitly deferred — decision 2).
- No partial payments, retries-after-decline, or re-confirm-after-timeout (timeout is terminal cancel).
- No payment in the order read model (3c-ii decision preserved).

## Success criteria

1. A placed order does **not** authorize until the customer clicks **Confirm payment**; before that
   the tracking page shows the confirm button and the payment status is `null`.
2. After confirm, the order authorizes (or declines by amount) and the existing merchant SLA race
   proceeds unchanged; the tracking page reflects Authorized → Paid (or Payment failed).
3. An order never confirmed within `PAYMENT_CONFIRM_TIMEOUT_SECONDS` auto-cancels with
   `PAYMENT_TIMEOUT` → "Payment not confirmed", and **no payment row** is created.
4. The confirm endpoint is customer-role-gated and tenant-scoped. The merchant can view an order at
   any time but can only accept/decline once its payment is `AUTHORIZED` — enforced in the UI
   (buttons disabled + "Awaiting customer payment") and authoritatively by write-api (`409` otherwise).
5. All suites green — updated 3c saga e2e + new confirm/timeout cases, write-api confirm e2e,
   web-shared vitest, updated Playwright flows; existing order/telemetry/Avro suites unaffected.
