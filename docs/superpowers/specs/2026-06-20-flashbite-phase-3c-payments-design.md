# Phase 3c — Real payments (design)

**Status:** approved (brainstorm) — ready for implementation plan
**Date:** 2026-06-20
**Builds on:** Phase 3a (event-sourced Order aggregate) + 3b (Avro bus). Slice **3c** of Phase 3.

## Goal

Replace the two fake payment Temporal activities (`chargePaymentActivity` /
`refundPaymentActivity`, which only `console.log`) with a **real, self-built payment provider**: a
new `payments` service that emulates a PSP with an **authorize → capture → void** lifecycle,
idempotent operations, a persisted ledger, and a deterministic **decline** path. A declined
authorization cancels the order with a new `PAYMENT_FAILED` reason — the failure→compensation path
that is missing today.

## Decisions (locked during brainstorm)

1. **Self-built local `payments` service** (not Stripe) — local-first, secret-free, CI-green, like
   `identity`.
2. **Authorize → capture / void**, **synchronous** HTTP from the saga activities. Declined authorize
   → immediate `PAYMENT_FAILED` cancel.
3. **Payments owns its ledger** (its own `flashbite_payments` DB). The Order aggregate is unchanged;
   a decline surfaces as `OrderCancelled(PAYMENT_FAILED)`. Payments is a separate bounded context;
   the saga orchestrates across it.
4. **Deterministic amount-based decline** (an `AUTH_DECLINE_THRESHOLD`), so demos/tests hit both
   paths with no new plumbing.
5. **Purely synchronous HTTP** — payments is NOT on the Kafka/Avro bus. No `payment-events` topic, no
   payment read model (backlog).
6. **No refund** — the lifecycle never captures-then-undoes (capture happens only on accept, which is
   terminal), so `void` is the only reversal. Refund is backlog.

## Current state (what 3c changes)

`apps/saga-worker/src/activities.ts`:
- `chargePaymentActivity(tenantId, orderId, amount)` → `console.log` only.
- `refundPaymentActivity(tenantId, orderId, amount)` → `console.log` only.

`apps/saga-worker/src/workflows.ts` (`orderLifecycleWorkflow`):
```
await chargePaymentActivity(...)                       // up front, cannot fail
const signalledInTime = await condition(approved !== undefined, `${slaSeconds}s`)
if (signalledInTime && approved) { recordOrderAccepted(); return ACCEPTED }
await refundPaymentActivity(...)
reason = signalledInTime ? DECLINED : SLA_BREACH
recordOrderCancelled(reason); return CANCELLED_*
```
`@flashbite/contracts`: `ORDER_CANCEL_REASONS = { SLA_BREACH, DECLINED }`,
`ORDER_SAGA_RESULTS = { ACCEPTED, CANCELLED_SLA, CANCELLED_DECLINED }`.

There is no payment store, no idempotency, and no payment-failure path.

## New service: `apps/payments` (NestJS, :3004)

A bounded context emulating a PSP. **Internal-only** — called by `saga-worker`; no JWT (service-to-
service auth is backlog). `tenantId` is passed in each request body. Reads its own config:
`PAYMENTS_DATABASE_URL` and `AUTH_DECLINE_THRESHOLD`.

### Endpoints (all idempotent)

- `POST /payments/authorize` — body `{ tenantId, orderId, amount, idempotencyKey }` →
  `200 { paymentId, status }` where `status` is `"authorized"` or `"declined"`.
  - Decline rule: `status = amount >= AUTH_DECLINE_THRESHOLD ? "declined" : "authorized"`
    (threshold in the same minor/whole units as `totalAmount`; default chosen so normal demo orders
    pass and a deliberately large order declines — documented in the README).
  - Creates/returns the `payment` row for `(tenantId, orderId)`.
- `POST /payments/capture` — body `{ tenantId, orderId, idempotencyKey }` → `200 { paymentId, status:"captured" }`.
  - Captures an `AUTHORIZED` payment. Idempotent: capturing an already-`CAPTURED` one returns it.
- `POST /payments/void` — body `{ tenantId, orderId, idempotencyKey }` → `200 { paymentId, status:"voided" }`.
  - Voids an `AUTHORIZED` payment. Idempotent: voiding an already-`VOIDED` one returns it.
- `GET /health` — liveness (excluded from any middleware), for infra wait + parity with other apps.

### Error/transition rules

- Authorize when a payment already exists for `(tenantId, orderId)`: return the existing row
  (idempotent — handles Temporal retries and re-delivered `OrderPlaced`).
- Capture/void a `DECLINED` or non-existent payment → `409 Conflict` (illegal transition). The saga
  never does this in the happy paths; it's a guard.
- Capture a `VOIDED` payment or void a `CAPTURED` payment → `409 Conflict`. (The workflow's ordering
  makes these unreachable, but the service enforces the state machine.)

### Data model (`flashbite_payments` DB, payments-owned Prisma schema)

`payment` table:
- `id` (uuid, the `paymentId`)
- `tenantId` (string)
- `orderId` (string)
- `amount` (int — matches order `totalAmount`)
- `status` (enum: `AUTHORIZED | CAPTURED | VOIDED | DECLINED`)
- `authorizedAt`, `capturedAt`, `voidedAt` (nullable timestamps)
- `createdAt`, `updatedAt`
- **Unique constraint `(tenantId, orderId)`** — one payment per order; the natural idempotency key
  for authorize.

Tenant isolation is by the `tenantId` column + scoped queries (no Postgres RLS — payments is internal
with a single trusted caller, not behind tenant-from-JWT).

> Note: idempotency for authorize rests on the `(tenantId, orderId)` unique row; capture/void
> idempotency rests on the status machine (re-applying a terminal transition returns current state).
> The `idempotencyKey` in each request is the stable PSP-style key the saga passes
> (`auth|capture|void:{tenantId}:{orderId}`); it is logged and may be stored for audit, but the row
> uniqueness + status checks are what guarantee exactly-once effect under Temporal retries.

## Saga changes (`apps/saga-worker`)

New `payments-client.ts` (HTTP client, reads `config.paymentsUrl`):
- `authorizePayment(tenantId, orderId, amount): Promise<{ paymentId: string; authorized: boolean }>`
- `capturePayment(tenantId, orderId): Promise<void>`
- `voidPayment(tenantId, orderId): Promise<void>`

Each builds the stable idempotency key and POSTs to the payments service; non-2xx (other than a
clean declined-authorize 200) throws so Temporal retries.

`activities.ts` — replace the two fakes with:
- `authorizePaymentActivity(tenantId, orderId, amount): Promise<{ authorized: boolean }>`
- `capturePaymentActivity(tenantId, orderId): Promise<void>`
- `voidPaymentActivity(tenantId, orderId): Promise<void>`

`recordOrderAcceptedActivity` / `recordOrderCancelledActivity` are unchanged (aggregate append).

`workflows.ts` — new shape:
```ts
const { authorized } = await authorizePaymentActivity(tenantId, orderId, totalAmount);
if (!authorized) {
  await recordOrderCancelledActivity(tenantId, orderId, ORDER_CANCEL_REASONS.PAYMENT_FAILED);
  return ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_FAILED;
}
const signalledInTime = await condition(() => approved !== undefined, `${slaSeconds}s`);
if (signalledInTime && approved) {
  await capturePaymentActivity(tenantId, orderId);
  await recordOrderAcceptedActivity(tenantId, orderId);
  return ORDER_SAGA_RESULTS.ACCEPTED;
}
await voidPaymentActivity(tenantId, orderId);
const reason = signalledInTime ? ORDER_CANCEL_REASONS.DECLINED : ORDER_CANCEL_REASONS.SLA_BREACH;
await recordOrderCancelledActivity(tenantId, orderId, reason);
return reason === ORDER_CANCEL_REASONS.SLA_BREACH ? ORDER_SAGA_RESULTS.CANCELLED_SLA : ORDER_SAGA_RESULTS.CANCELLED_DECLINED;
```
The workflow stays deterministic — all HTTP is in activities; constants come from the pure
`@flashbite/contracts`; no new imports into the workflow bundle beyond contracts.

## Contracts (`@flashbite/contracts`)

- `ORDER_CANCEL_REASONS`: add `PAYMENT_FAILED: "PAYMENT_FAILED"`.
- `ORDER_SAGA_RESULTS`: add `CANCELLED_PAYMENT_FAILED: "CANCELLED_PAYMENT_FAILED"`.

(Pure constant additions — no runtime deps.)

## Config & infra

- `packages/shared/src/config.ts`: add `paymentsUrl: env.PAYMENTS_URL ?? "http://localhost:3004"` to
  `AppConfig`/`loadConfig` (read by saga-worker).
- `.env.example`: add `PAYMENTS_URL`, `PAYMENTS_DATABASE_URL`
  (`postgresql://flashbite:...@localhost:5432/flashbite_payments`), `AUTH_DECLINE_THRESHOLD`.
- **New Postgres database `flashbite_payments`** in the existing Postgres container — created by a
  one-shot init (compose `postgres-init`-style `CREATE DATABASE`, or a documented `createdb` step).
  The payments service owns its Prisma schema at `apps/payments/prisma/schema.prisma`
  (datasource `PAYMENTS_DATABASE_URL`) with its own client + migrations.
- Root `package.json`: `dev:payments` (run the service), and payments DB scripts
  (`payments:db:deploy` / `:generate` analogous to the existing `db:*`).
- CI (`infra/docker-compose.ci.yml` + `.github/workflows/test.yml`): ensure `flashbite_payments`
  exists and payments migrations are applied before tests; start the payments service for the saga
  e2e (or the saga e2e boots it in-process — see Testing).

## Frontend

`cancelReason` can now be `PAYMENT_FAILED`. The customer tracking, merchant, and admin views already
render `cancelReason`, so the only change is a label mapping for `PAYMENT_FAILED` in the web-shared
status helpers (e.g. "Payment failed"). No structural FE change.

## Testing

- **payments service (Jest e2e, live `flashbite_payments`):**
  - authorize → `authorized` for a normal amount; `declined` for an amount `>= AUTH_DECLINE_THRESHOLD`.
  - capture an authorized payment → `CAPTURED`; void an authorized payment → `VOIDED`.
  - **idempotency:** repeating authorize/capture/void for the same `(tenantId, orderId)` returns the
    same result (no duplicate rows, no double transition).
  - illegal transitions (capture a declined / void a captured) → `409`.
- **saga-worker e2e (Temporal + payments):**
  - **PAYMENT_FAILED path:** an order with a declining amount → workflow authorizes (declined) →
    `OrderCancelled(PAYMENT_FAILED)`, no capture, payment row `DECLINED`.
  - accept path: authorize → merchant approves → capture → `OrderAccepted`, payment `CAPTURED`.
  - decline/SLA path: authorize → decline/timeout → void → `OrderCancelled(DECLINED|SLA_BREACH)`,
    payment `VOIDED`.
  - Update the existing saga tests that referenced `chargePayment`/`refundPayment`.
  - The saga e2e needs the payments service reachable: start it (in CI and locally) before the suite,
    or run the workflow against a booted payments app. (Implementation plan picks the simplest stable
    option — likely a real payments service started in CI like the other infra-dependent suites.)

## Scope boundary / backlog

- **Refund** (capture-then-refund) — not reachable in this lifecycle.
- **Async webhook settlement** — synchronous only here.
- **Payment read model** — Kafka `payment-events` topic + Avro subjects + projection (brainstorm
  option C).
- **Real Stripe / payment-method tokens** — self-built gateway only.
- **Service-to-service auth** between saga and payments.

## Success criteria

1. The fake `charge`/`refund` activities are gone; the saga drives authorize → capture/void against
   the real `payments` service.
2. A declined authorization cancels the order with `PAYMENT_FAILED`, with no capture and a `DECLINED`
   ledger row.
3. The accept path captures; the decline/SLA path voids — verified end-to-end through Temporal.
4. Payment operations are idempotent — Temporal retries never double-charge or duplicate rows.
5. Payments has its own DB; the Order aggregate and event store are unchanged.
6. All suites green (payments e2e, saga e2e, plus the existing order/telemetry/Avro suites) and CI
   provisions `flashbite_payments`.
