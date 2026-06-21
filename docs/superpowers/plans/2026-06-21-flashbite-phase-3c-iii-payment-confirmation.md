# Phase 3c-iii — Customer Payment Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate order authorization behind an explicit customer "Confirm payment" action — the saga waits for a confirm signal before authorizing, auto-cancels (`PAYMENT_TIMEOUT`) if it never comes, and the merchant can only accept/decline once payment is `AUTHORIZED`.

**Architecture:** A new `confirmPayment` Temporal signal + a guarded `condition()` before `authorizePaymentActivity`. A customer-role `POST /orders/:id/confirm-payment` endpoint signals it. The merchant accept/decline endpoints (and merchant UI) are gated on payment being `AUTHORIZED` via a payments-status lookup. The customer tracking page shows a "Confirm payment €X" button while awaiting.

**Tech Stack:** Temporal (`@temporalio/workflow`, `TestWorkflowEnvironment`), NestJS 10.4.4 (write-api :3001), `@flashbite/contracts` / `@flashbite/shared`, Jest (saga + write-api e2e), Next.js 16 (web-customer/merchant), Vitest (web-shared).

**Branch:** `phase-3c-iii-payment-confirmation` (created, stacked on `phase-3c-ii-payment-ui` / PR #24).

---

## File Structure

**New files:**
- `apps/write-api/src/orders/confirm-payment.controller.ts` — customer confirm endpoint.
- `apps/write-api/src/orders/payments-client.ts` — payments-status lookup for the accept/decline gate.
- `apps/saga-worker/test/payment-timeout.e2e-spec.ts` — no-confirm → PAYMENT_TIMEOUT.

**Modified files:**
- `packages/contracts/src/index.ts` — `CONFIRM_PAYMENT_SIGNAL`, `PAYMENT_TIMEOUT`, `CANCELLED_PAYMENT_TIMEOUT`.
- `packages/contracts/src/contracts.spec.ts` — assert new constants.
- `packages/shared/src/config.ts` — `paymentConfirmTimeoutSeconds`.
- `.env.example` — `PAYMENT_CONFIRM_TIMEOUT_SECONDS`.
- `apps/saga-worker/src/workflows.ts` — confirm signal + gate + `OrderLifecycleArgs.confirmSeconds`.
- `apps/saga-worker/src/main.ts` — thread `confirmSeconds` into the workflow args.
- `apps/saga-worker/test/workflow.spec.ts` — confirm-first in each case + a timeout case.
- `apps/saga-worker/test/saga.e2e-spec.ts`, `payment-failed.e2e-spec.ts`, `breach.e2e-spec.ts` — confirm-first + `confirmSeconds` arg.
- `apps/write-api/src/orders/accept.controller.ts` — `409` gate on payment AUTHORIZED.
- `apps/write-api/src/orders/orders.module.ts` — register `PaymentsClient` + `ConfirmPaymentController`.
- `apps/write-api/test/accept.e2e-spec.ts` — confirm+authorize before accept; `409`-when-unpaid case.
- `packages/web-shared/src/api/client.ts` (+ `.test.ts`) — `confirmPayment`.
- `packages/web-shared/src/orders/order-events.ts` (+ `.test.ts`) — `PAYMENT_TIMEOUT` label.
- `packages/web-shared/src/index.ts` — export `confirmPayment`.
- `apps/web-customer/app/orders/[orderId]/page.tsx` — "Confirm payment" button.
- `apps/web-merchant/components/order-detail-sheet.tsx` — read-only until payment authorized.
- `docs/ARCHITECTURE.md`, `apps/write-api/requests.http` — docs.

---

## Task 1: Contracts — signal + timeout constants

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/contracts.spec.ts`

- [ ] **Step 1: Add the constants**

In `packages/contracts/src/index.ts`, edit the three existing objects:

`ORDER_SAGA` (currently `{ TASK_QUEUE, WORKFLOW_TYPE, MERCHANT_APPROVAL_SIGNAL }`) — add the signal name:
```ts
export const ORDER_SAGA = {
  TASK_QUEUE: "order-lifecycle",
  WORKFLOW_TYPE: "orderLifecycleWorkflow",
  MERCHANT_APPROVAL_SIGNAL: "merchantApproval",
  CONFIRM_PAYMENT_SIGNAL: "confirmPayment",
} as const;
```

`ORDER_SAGA_RESULTS` — add the new terminal result:
```ts
  CANCELLED_PAYMENT_TIMEOUT: "CANCELLED_PAYMENT_TIMEOUT",
```

`ORDER_CANCEL_REASONS` — add the new reason:
```ts
  PAYMENT_TIMEOUT: "PAYMENT_TIMEOUT",
```

- [ ] **Step 2: Extend the contracts spec**

Open `packages/contracts/src/contracts.spec.ts` and add assertions wherever it checks `ORDER_CANCEL_REASONS` / `ORDER_SAGA_RESULTS` / `ORDER_SAGA` (match the existing assertion style — do not weaken existing checks). For example:
```ts
expect(ORDER_CANCEL_REASONS.PAYMENT_TIMEOUT).toBe("PAYMENT_TIMEOUT");
expect(ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_TIMEOUT).toBe("CANCELLED_PAYMENT_TIMEOUT");
expect(ORDER_SAGA.CONFIRM_PAYMENT_SIGNAL).toBe("confirmPayment");
```

- [ ] **Step 3: Run the contracts suite**

Run: `pnpm jest packages/contracts -- --silent`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/contracts.spec.ts
git commit -m "feat(contracts): confirmPayment signal + PAYMENT_TIMEOUT (3c-iii)"
```

---

## Task 2: Shared config — confirm timeout

**Files:**
- Modify: `packages/shared/src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add the config field**

In `packages/shared/src/config.ts`: add to the `AppConfig` interface (next to `sagaSlaSeconds`):
```ts
  paymentConfirmTimeoutSeconds: number;
```
and to the returned object in `loadConfig` (next to `sagaSlaSeconds: Number(env.SAGA_SLA_SECONDS ?? 300),`):
```ts
    paymentConfirmTimeoutSeconds: Number(env.PAYMENT_CONFIRM_TIMEOUT_SECONDS ?? 120),
```

- [ ] **Step 2: Document the env var**

In `.env.example`, near `SAGA_SLA_SECONDS`, add:
```
# Seconds the saga waits for the customer to confirm payment before auto-cancelling (PAYMENT_TIMEOUT).
PAYMENT_CONFIRM_TIMEOUT_SECONDS=120
```

- [ ] **Step 3: Typecheck shared**

Run: `pnpm jest packages/shared -- --silent`
Expected: PASS (existing shared tests still green; pure additive config).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/config.ts .env.example
git commit -m "feat(shared): paymentConfirmTimeoutSeconds config (3c-iii)"
```

---

## Task 3: Saga workflow — confirm gate + unit tests

**Files:**
- Modify: `apps/saga-worker/src/workflows.ts`
- Modify: `apps/saga-worker/src/main.ts`
- Test: `apps/saga-worker/test/workflow.spec.ts`

- [ ] **Step 1: Update the failing unit tests first**

Rewrite `apps/saga-worker/test/workflow.spec.ts` to (a) import the new signal, (b) add `confirmSeconds` to every `args`, (c) send the confirm signal in the paths that should authorize, and (d) add a no-confirm timeout case. Full file:

```ts
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import path from "node:path";
import { orderLifecycleWorkflow, merchantApprovalSignal, confirmPaymentSignal } from "../src/workflows";

describe("orderLifecycleWorkflow", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120000);
  afterAll(async () => {
    await env?.teardown();
  });

  const calls: string[] = [];
  let authorizeResult = true; // toggled per test
  const stubActivities = {
    async authorizePaymentActivity() { calls.push("authorize"); return { authorized: authorizeResult }; },
    async capturePaymentActivity() { calls.push("capture"); },
    async voidPaymentActivity() { calls.push("void"); },
    async recordOrderAcceptedActivity() { calls.push("accepted"); },
    async recordOrderCancelledActivity(_t: string, _o: string, reason: string) { calls.push(`cancelled:${reason}`); },
  };

  async function runWorker<T>(fn: () => Promise<T>): Promise<T> {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test-sla",
      workflowsPath: path.join(__dirname, "../src/workflows.ts"),
      activities: stubActivities,
    });
    return worker.runUntil(fn);
  }

  const baseArgs = (orderId: string, totalAmount = 1200) => ({
    tenantId: "berlin", orderId, totalAmount, slaSeconds: 300, confirmSeconds: 300,
  });

  it("ACCEPTED when confirmed, then approved before the SLA", async () => {
    calls.length = 0; authorizeResult = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:accept-${Date.now()}`,
        args: [baseArgs("o1")],
      });
      await handle.signal(confirmPaymentSignal);
      await handle.signal(merchantApprovalSignal, true);
      return handle.result();
    });
    expect(result).toBe("ACCEPTED");
    expect(calls).toEqual(["authorize", "capture", "accepted"]);
  });

  it("CANCELLED_PAYMENT_TIMEOUT when the customer never confirms (time-skipped)", async () => {
    calls.length = 0; authorizeResult = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:noconfirm-${Date.now()}`,
        args: [baseArgs("o0")],
      });
      return handle.result();
    });
    expect(result).toBe("CANCELLED_PAYMENT_TIMEOUT");
    expect(calls).toEqual(["cancelled:PAYMENT_TIMEOUT"]); // never authorized
  });

  it("CANCELLED_SLA when confirmed but no approval before the SLA (time-skipped)", async () => {
    calls.length = 0; authorizeResult = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:breach-${Date.now()}`,
        args: [baseArgs("o2")],
      });
      await handle.signal(confirmPaymentSignal);
      return handle.result();
    });
    expect(result).toBe("CANCELLED_SLA");
    expect(calls).toEqual(["authorize", "void", "cancelled:SLA_BREACH"]);
  });

  it("CANCELLED_DECLINED when confirmed then the merchant declines", async () => {
    calls.length = 0; authorizeResult = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:decline-${Date.now()}`,
        args: [baseArgs("o3")],
      });
      await handle.signal(confirmPaymentSignal);
      await handle.signal(merchantApprovalSignal, false);
      return handle.result();
    });
    expect(result).toBe("CANCELLED_DECLINED");
    expect(calls).toEqual(["authorize", "void", "cancelled:DECLINED"]);
  });

  it("CANCELLED_PAYMENT_FAILED when confirmed but authorize is declined (no capture/void)", async () => {
    calls.length = 0; authorizeResult = false;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:payfail-${Date.now()}`,
        args: [baseArgs("o4", 100000)],
      });
      await handle.signal(confirmPaymentSignal);
      return handle.result();
    });
    expect(result).toBe("CANCELLED_PAYMENT_FAILED");
    expect(calls).toEqual(["authorize", "cancelled:PAYMENT_FAILED"]);
    authorizeResult = true;
  });
});
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `pnpm jest apps/saga-worker/test/workflow.spec.ts -- --silent`
Expected: FAIL — `confirmPaymentSignal` is not exported / `confirmSeconds` not in args type / timeout case unmet.

- [ ] **Step 3: Implement the workflow gate**

Replace `apps/saga-worker/src/workflows.ts` with:

```ts
import { proxyActivities, condition, defineSignal, setHandler } from "@temporalio/workflow";
import { ORDER_SAGA, ORDER_SAGA_RESULTS, ORDER_CANCEL_REASONS } from "@flashbite/contracts";
import type { Activities } from "./activities";

export const merchantApprovalSignal = defineSignal<[boolean]>(ORDER_SAGA.MERCHANT_APPROVAL_SIGNAL);
export const confirmPaymentSignal = defineSignal(ORDER_SAGA.CONFIRM_PAYMENT_SIGNAL);

const { authorizePaymentActivity, capturePaymentActivity, voidPaymentActivity, recordOrderAcceptedActivity, recordOrderCancelledActivity } =
  proxyActivities<Activities>({ startToCloseTimeout: "1 minute" });

export interface OrderLifecycleArgs {
  tenantId: string;
  orderId: string;
  totalAmount: number;
  slaSeconds: number;
  confirmSeconds: number;
}

/**
 * Wait for the customer to confirm payment -> authorize a hold -> race the SLA timer against
 * the merchant-approval signal. No confirm in time -> OrderCancelled(PAYMENT_TIMEOUT), no authorize.
 * Declined authorize -> OrderCancelled(PAYMENT_FAILED). Approved in time -> capture + OrderAccepted.
 * Declined or SLA breach -> void + OrderCancelled. Deterministic: all I/O is in activities.
 */
export async function orderLifecycleWorkflow(args: OrderLifecycleArgs): Promise<string> {
  let approved: boolean | undefined;
  let confirmed = false;
  setHandler(merchantApprovalSignal, (value) => { approved = value; });
  setHandler(confirmPaymentSignal, () => { confirmed = true; });

  const confirmedInTime = await condition(() => confirmed, `${args.confirmSeconds}s`);
  if (!confirmedInTime) {
    await recordOrderCancelledActivity(args.tenantId, args.orderId, ORDER_CANCEL_REASONS.PAYMENT_TIMEOUT);
    return ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_TIMEOUT;
  }

  const { authorized } = await authorizePaymentActivity(args.tenantId, args.orderId, args.totalAmount);
  if (!authorized) {
    await recordOrderCancelledActivity(args.tenantId, args.orderId, ORDER_CANCEL_REASONS.PAYMENT_FAILED);
    return ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_FAILED;
  }

  const signalledInTime = await condition(() => approved !== undefined, `${args.slaSeconds}s`);

  if (signalledInTime && approved) {
    await capturePaymentActivity(args.tenantId, args.orderId);
    await recordOrderAcceptedActivity(args.tenantId, args.orderId);
    return ORDER_SAGA_RESULTS.ACCEPTED;
  }

  await voidPaymentActivity(args.tenantId, args.orderId);
  const reason = signalledInTime ? ORDER_CANCEL_REASONS.DECLINED : ORDER_CANCEL_REASONS.SLA_BREACH;
  await recordOrderCancelledActivity(args.tenantId, args.orderId, reason);
  return reason === ORDER_CANCEL_REASONS.SLA_BREACH ? ORDER_SAGA_RESULTS.CANCELLED_SLA : ORDER_SAGA_RESULTS.CANCELLED_DECLINED;
}
```

- [ ] **Step 4: Thread `confirmSeconds` through the starter**

In `apps/saga-worker/src/main.ts`:
- Add a `confirmSeconds` parameter to `startOrderConsumer` (after `slaSeconds: number,`):
  ```ts
    slaSeconds: number,
    confirmSeconds: number,
  ```
- Include it in the workflow `args` (line ~67):
  ```ts
          args: [{ tenantId: envelope.tenantId, orderId: p.orderId, totalAmount: p.totalAmount, slaSeconds, confirmSeconds }],
  ```
- Pass it at the call site in `main()` (line ~89):
  ```ts
  const orderConsumer = await startOrderConsumer(consumer, temporal, config.sagaSlaSeconds, config.paymentConfirmTimeoutSeconds, registry);
  ```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `pnpm jest apps/saga-worker/test/workflow.spec.ts -- --silent`
Expected: PASS (all 5 cases).

- [ ] **Step 6: Commit**

```bash
git add apps/saga-worker/src/workflows.ts apps/saga-worker/src/main.ts apps/saga-worker/test/workflow.spec.ts
git commit -m "feat(saga): customer confirm-payment gate before authorize (3c-iii)"
```

---

## Task 4: Saga e2e — confirm-first + timeout case

**Files:**
- Modify: `apps/saga-worker/test/saga.e2e-spec.ts`, `payment-failed.e2e-spec.ts`, `breach.e2e-spec.ts`
- Create: `apps/saga-worker/test/payment-timeout.e2e-spec.ts`

> These boot a real saga worker (real activities → payments service :3004) + live Temporal/Postgres. Infra must be up (`pnpm infra:up`) and the payments service running for authorize/capture/void. Each existing test starts the workflow directly, so it must now (a) add `confirmSeconds` to args and (b) signal `confirmPaymentSignal` before expecting authorization.

- [ ] **Step 1: Update `saga.e2e-spec.ts`**

Add `confirmPaymentSignal` to the import from `../src/workflows` (alongside `merchantApprovalSignal`). In the "approved order" test, add `confirmSeconds: 60` to the args and signal confirm before the merchant signal:
```ts
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 60, confirmSeconds: 60 }],
    });
    await handle.signal(confirmPaymentSignal);
    await handle.signal(merchantApprovalSignal, true);
```

- [ ] **Step 2: Update `payment-failed.e2e-spec.ts`**

Add the confirm import + signal and `confirmSeconds`:
```ts
import { confirmPaymentSignal } from "../src/workflows";
```
```ts
      args: [{ tenantId: "berlin", orderId, totalAmount: declineAmount, slaSeconds: 60, confirmSeconds: 60 }],
    });
    await handle.signal(confirmPaymentSignal);
    const result = await handle.result();
```

- [ ] **Step 3: Update `breach.e2e-spec.ts`**

Add the confirm import + signal and `confirmSeconds` (keep `slaSeconds: 2` so the SLA still breaches quickly after confirm):
```ts
import { confirmPaymentSignal } from "../src/workflows";
```
```ts
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 2, confirmSeconds: 60 }],
    });
    await handle.signal(confirmPaymentSignal);
    const result = await handle.result();
```

- [ ] **Step 4: Create the no-confirm timeout e2e**

Create `apps/saga-worker/test/payment-timeout.e2e-spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, appendWithExpectedVersion, TemporalHandle } from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES, ORDER_CANCEL_REASONS } from "@flashbite/contracts";
import { startSagaWorker, SagaWorkerHandle } from "../src/main";

describe("saga-worker payment-timeout (e2e: customer never confirms)", () => {
  const prisma = new PrismaClient();
  let temporal: TemporalHandle;
  let saga: SagaWorkerHandle;

  beforeAll(async () => {
    await prisma.$connect();
    temporal = await connectTemporal();
    saga = await startSagaWorker();
  }, 60000);
  afterAll(async () => {
    await saga?.stop();
    await temporal?.connection.close();
    await prisma.$disconnect();
  });

  it("no confirm within the window -> OrderCancelled(PAYMENT_TIMEOUT), no payment row", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, {
      tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
      expectedVersion: 0, eventType: EVENT_TYPES.ORDER_PLACED,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: 1200 },
    });

    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 60, confirmSeconds: 2 }],
    });
    const result = await handle.result(); // never signal confirm
    expect(result).toBe("CANCELLED_PAYMENT_TIMEOUT");

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["OrderPlaced", "OrderCancelled"]);
    expect((events[1].payload as { reason: string }).reason).toBe(ORDER_CANCEL_REASONS.PAYMENT_TIMEOUT);

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);
});
```

- [ ] **Step 5: Run the saga e2e suites**

Run: `pnpm jest apps/saga-worker -- --silent` (infra up + payments running)
Expected: PASS (workflow unit + all e2e incl. the new timeout). `aggregate-race.e2e-spec.ts` is unaffected (it appends events + calls an activity directly, never starting the workflow).

- [ ] **Step 6: Commit**

```bash
git add apps/saga-worker/test/saga.e2e-spec.ts apps/saga-worker/test/payment-failed.e2e-spec.ts apps/saga-worker/test/breach.e2e-spec.ts apps/saga-worker/test/payment-timeout.e2e-spec.ts
git commit -m "test(saga): confirm-first e2e + no-confirm PAYMENT_TIMEOUT (3c-iii)"
```

---

## Task 5: write-api — confirm endpoint + accept/decline payment gate

**Files:**
- Create: `apps/write-api/src/orders/payments-client.ts`
- Create: `apps/write-api/src/orders/confirm-payment.controller.ts`
- Modify: `apps/write-api/src/orders/accept.controller.ts`
- Modify: `apps/write-api/src/orders/orders.module.ts`
- Test: `apps/write-api/test/accept.e2e-spec.ts`

- [ ] **Step 1: Add the payments-status client**

Create `apps/write-api/src/orders/payments-client.ts`:
```ts
import { Injectable } from "@nestjs/common";
import { loadConfig } from "@flashbite/shared";
import type { PaymentStatus } from "@flashbite/contracts";

/** Reads the order's payment status from the payments service to gate merchant actions (3c-iii). */
@Injectable()
export class PaymentsClient {
  private readonly baseUrl = loadConfig().paymentsUrl;

  async getStatus(tenantId: string, orderId: string): Promise<PaymentStatus | null> {
    const res = await fetch(
      `${this.baseUrl}/payments/${encodeURIComponent(tenantId)}/${encodeURIComponent(orderId)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`payments GET failed: ${res.status}`);
    const body = (await res.json()) as { status: PaymentStatus };
    return body.status;
  }
}
```

- [ ] **Step 2: Add the customer confirm endpoint**

Create `apps/write-api/src/orders/confirm-payment.controller.ts`:
```ts
import { Controller, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { getTenantId, Roles } from "@flashbite/tenant-context";
import { ORDER_SAGA, ROLES } from "@flashbite/contracts";
import { TemporalService } from "../temporal/temporal.service";

@Controller("orders")
export class ConfirmPaymentController {
  constructor(private readonly temporal: TemporalService) {}

  @Post(":orderId/confirm-payment")
  @HttpCode(202)
  @Roles(ROLES.CUSTOMER)
  async confirm(@Param("orderId") orderId: string): Promise<{ orderId: string; signalled: string }> {
    const tenantId = getTenantId();
    const handle = this.temporal.client.workflow.getHandle(`${tenantId}:${orderId}`);
    try {
      await handle.signal(ORDER_SAGA.CONFIRM_PAYMENT_SIGNAL);
    } catch (err) {
      if (/not found|NotFound/i.test(String(err))) {
        throw new NotFoundException(`No active order workflow for ${orderId}`);
      }
      throw err;
    }
    return { orderId, signalled: "confirm-payment" };
  }
}
```

- [ ] **Step 3: Gate accept/decline on AUTHORIZED payment**

Edit `apps/write-api/src/orders/accept.controller.ts`:
- Imports:
  ```ts
  import { Controller, ConflictException, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
  import { getTenantId, Roles } from "@flashbite/tenant-context";
  import { ORDER_SAGA, PAYMENT_STATUS, ROLES } from "@flashbite/contracts";
  import { TemporalService } from "../temporal/temporal.service";
  import { PaymentsClient } from "./payments-client";
  ```
- Constructor:
  ```ts
    constructor(
      private readonly temporal: TemporalService,
      private readonly payments: PaymentsClient,
    ) {}
  ```
- In the private `signal(...)`, add the gate before sending the merchant signal:
  ```ts
    private async signal(orderId: string, approved: boolean): Promise<{ orderId: string; signalled: string }> {
      const tenantId = getTenantId();
      const status = await this.payments.getStatus(tenantId, orderId);
      if (status !== PAYMENT_STATUS.AUTHORIZED) {
        throw new ConflictException(`Order ${orderId} payment is not authorized (status: ${status ?? "none"})`);
      }
      const handle = this.temporal.client.workflow.getHandle(`${tenantId}:${orderId}`);
      try {
        await handle.signal(ORDER_SAGA.MERCHANT_APPROVAL_SIGNAL, approved);
      } catch (err) {
        if (/not found|NotFound/i.test(String(err))) {
          throw new NotFoundException(`No active order workflow for ${orderId}`);
        }
        throw err;
      }
      return { orderId, signalled: approved ? "accept" : "decline" };
    }
  ```

- [ ] **Step 4: Register the provider + controller**

In `apps/write-api/src/orders/orders.module.ts`: add `ConfirmPaymentController` to `controllers` and `PaymentsClient` to `providers` (import both). Keep all existing entries.

- [ ] **Step 5: Update the accept e2e (confirm+authorize before accept; 409 when unpaid)**

Edit `apps/write-api/test/accept.e2e-spec.ts`. The workflow now waits for confirm before authorizing, and accept is gated on AUTHORIZED. Add a `customer` token, signal confirm, wait until the payment is authorized, then accept. Replace the test body and add a 409 case:

```ts
  // in beforeAll, after minting merchant:
  customer = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
```
(add `let customer: string;` alongside `let merchant: string;`)

```ts
  it("accept is rejected (409) before the payment is authorized", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, { tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId, expectedVersion: 0, eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId, customerId: "c-1", items: [], totalAmount: 1200 } });
    await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 60, confirmSeconds: 60 }],
    });
    const res = await request(app.getHttpServer())
      .post(`/orders/${orderId}/accept`)
      .set("Authorization", `Bearer ${merchant}`);
    expect(res.status).toBe(409);

    await temporal.client.workflow.getHandle(`berlin:${orderId}`).terminate().catch(() => undefined);
    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);

  it("POST /orders/:id/accept after confirm+authorize -> ACCEPTED + OrderAccepted event", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, { tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId, expectedVersion: 0, eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId, customerId: "c-1", items: [], totalAmount: 1200 } });
    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 60, confirmSeconds: 60 }],
    });

    // customer confirms -> saga authorizes; poll accept until the gate opens (payment AUTHORIZED)
    await request(app.getHttpServer()).post(`/orders/${orderId}/confirm-payment`).set("Authorization", `Bearer ${customer}`).expect(202);
    let acceptStatus = 0;
    for (let i = 0; i < 30 && acceptStatus !== 202; i++) {
      const r = await request(app.getHttpServer()).post(`/orders/${orderId}/accept`).set("Authorization", `Bearer ${merchant}`);
      acceptStatus = r.status;
      if (acceptStatus !== 202) await new Promise((res) => setTimeout(res, 500));
    }
    expect(acceptStatus).toBe(202);

    const result = await handle.result();
    expect(result).toBe("ACCEPTED");

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);
```
(Remove the old single accept test that started the workflow and accepted immediately — it is replaced by the two above. Keep the imports; `request`, `randomUUID`, `appendWithExpectedVersion`, etc. are already imported.)

- [ ] **Step 6: Run the write-api accept e2e**

Run: `pnpm jest apps/write-api/test/accept.e2e-spec.ts -- --silent` (infra up + payments running)
Expected: PASS (409-when-unpaid + accept-after-confirm).

- [ ] **Step 7: Commit**

```bash
git add apps/write-api/src/orders/payments-client.ts apps/write-api/src/orders/confirm-payment.controller.ts apps/write-api/src/orders/accept.controller.ts apps/write-api/src/orders/orders.module.ts apps/write-api/test/accept.e2e-spec.ts
git commit -m "feat(write-api): confirm-payment endpoint + accept/decline payment gate (3c-iii)"
```

---

## Task 6: web-shared — `confirmPayment` + timeout label

**Files:**
- Modify: `packages/web-shared/src/api/client.ts` (+ `client.test.ts`)
- Modify: `packages/web-shared/src/orders/order-events.ts` (+ `order-events.test.ts`)
- Modify: `packages/web-shared/src/index.ts`

- [ ] **Step 1: Failing tests**

In `packages/web-shared/src/api/client.test.ts` add (import `confirmPayment` from `./client`):
```ts
  it("confirmPayment POSTs the confirm signal with Bearer, no X-Tenant-ID", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));
    await confirmPayment("o-1");
    expect(lastUrl()).toBe("/api/write/orders/o-1/confirm-payment");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });
```
In `packages/web-shared/src/orders/order-events.test.ts` (where `cancelReasonLabel` is tested) add:
```ts
  it("labels PAYMENT_TIMEOUT", () => {
    expect(cancelReasonLabel("PAYMENT_TIMEOUT")).toBe("Payment not confirmed");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @flashbite/web-shared test -- client order-events`
Expected: FAIL (`confirmPayment` undefined; PAYMENT_TIMEOUT label missing).

- [ ] **Step 3: Implement**

In `packages/web-shared/src/api/client.ts`, after the `signalOrder`/`acceptOrder`/`declineOrder` block, add:
```ts
/** POST /orders/:id/confirm-payment — customer confirms; the saga then authorizes. */
export async function confirmPayment(orderId: string): Promise<void> {
  const res = await authedFetch(`/api/write/orders/${encodeURIComponent(orderId)}/confirm-payment`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`confirmPayment failed: ${res.status}`);
}
```

In `packages/web-shared/src/orders/order-events.ts`, add to `CANCEL_REASON_LABELS`:
```ts
  PAYMENT_TIMEOUT: "Payment not confirmed",
```

- [ ] **Step 4: Export `confirmPayment`**

In `packages/web-shared/src/index.ts`, add `confirmPayment` to the `./api/client` export block (next to `acceptOrder, declineOrder`).

- [ ] **Step 5: Run the web-shared suite**

Run: `pnpm --filter @flashbite/web-shared test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web-shared/src/api/client.ts packages/web-shared/src/api/client.test.ts packages/web-shared/src/orders/order-events.ts packages/web-shared/src/orders/order-events.test.ts packages/web-shared/src/index.ts
git commit -m "feat(web-shared): confirmPayment client + PAYMENT_TIMEOUT label (3c-iii)"
```

---

## Task 7: web-customer — "Confirm payment" button

**Files:**
- Modify: `apps/web-customer/app/orders/[orderId]/page.tsx`

> Next 16 app (see `apps/web-customer/AGENTS.md`) — only adds state + a button to the existing `"use client"` component. The page (from 3c-ii) already polls `getOrder` + `fetchOrderPayment` and tracks `paymentStatus`.

- [ ] **Step 1: Import `confirmPayment`**

Add `confirmPayment` to the `@flashbite/web-shared` import block in the file.

- [ ] **Step 2: Add confirm state + handler**

Inside `OrderTrackingContent`, add state next to `paymentStatus`:
```ts
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
```
And a handler (above the `return`):
```ts
  const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;
  const awaitingConfirm = order?.status === ORDER_STATUS.PLACED && paymentStatus === null;

  const onConfirm = async () => {
    if (!order) return;
    setConfirming(true); setConfirmError(null);
    try {
      await confirmPayment(order.orderId);
      // saga authorizes shortly; the existing poll will surface Payment: Authorized
    } catch {
      setConfirmError("Couldn't confirm payment. Please try again.");
      setConfirming(false);
    }
  };
```

- [ ] **Step 3: Render the button**

Inside the `{order && (...)}` block, after the `Status` row and before the payment line, add:
```tsx
                {awaitingConfirm && (
                  <div className="space-y-2">
                    <Button className="w-full" disabled={confirming} onClick={onConfirm}>
                      {confirming ? "Confirming…" : `Confirm payment ${euro(order.totalAmount)}`}
                    </Button>
                    {confirmError && <p className="text-sm text-destructive">{confirmError}</p>}
                  </div>
                )}
```
(`Button` and `ORDER_STATUS` are already imported.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter web-customer exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web-customer/app/orders/[orderId]/page.tsx"
git commit -m "feat(web-customer): confirm-payment button on tracking page (3c-iii)"
```

---

## Task 8: web-merchant — read-only until paid

**Files:**
- Modify: `apps/web-merchant/components/order-detail-sheet.tsx`

> Next 16 app. The sheet currently shows Accept/Decline when `order.status === PLACED`. Gate those on the order's payment being `AUTHORIZED` (fetched via `fetchOrderPayment`).

- [ ] **Step 1: Imports + payment-status state**

Add `fetchOrderPayment` to the `@flashbite/web-shared` import. Add state + an effect that fetches payment status when the open order changes:
```ts
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);

  useEffect(() => {
    setPaymentStatus(null);
    if (!order) return;
    let active = true;
    fetchOrderPayment(order.orderId)
      .then((p) => { if (active) setPaymentStatus(p.status); })
      .catch(() => { if (active) setPaymentStatus(null); });
    return () => { active = false; };
  }, [order?.orderId]);
```
(The file already imports `useEffect, useState`.)

- [ ] **Step 2: Gate the action buttons**

Replace the `{order.status === ORDER_STATUS.PLACED && (...)}` action block with a payment-aware version:
```tsx
            {order.status === ORDER_STATUS.PLACED && (
              paymentStatus === "AUTHORIZED" ? (
                <div className="mt-6 flex gap-2">
                  <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => act(declineOrder)}>
                    {busy ? "…" : "Decline"}
                  </Button>
                  <Button className="flex-1" disabled={busy} onClick={() => act(acceptOrder)}>
                    {busy ? "…" : "Accept"}
                  </Button>
                </div>
              ) : (
                <p className="mt-6 text-sm text-muted-foreground">Awaiting customer payment…</p>
              )
            )}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web-merchant exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web-merchant/components/order-detail-sheet.tsx
git commit -m "feat(web-merchant): accept/decline gated on authorized payment (3c-iii)"
```

---

## Task 9: Docs + Playwright + full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `apps/write-api/requests.http`
- Modify: Playwright flows that place→progress an order (see Step 2)

- [ ] **Step 1: Document the confirm gate**

In `docs/ARCHITECTURE.md` §3, update the saga description (and the `saga-worker` row in the services table near line 105) to note the confirm gate: the workflow now first awaits a customer `confirmPayment` signal (timeout → `PAYMENT_TIMEOUT`) before authorizing, and the merchant accept/decline is gated on `AUTHORIZED` payment (write-api `409` otherwise). Add a bullet to the §3 design-decisions list:
```markdown
- **Customer payment confirmation (Phase 3c-iii):** the saga waits for a customer `confirmPayment`
  signal before authorizing; no confirm within `PAYMENT_CONFIRM_TIMEOUT_SECONDS` cancels with
  `PAYMENT_TIMEOUT`. The merchant may view but not accept/decline an order until its payment is
  `AUTHORIZED` (write-api returns `409` otherwise; the merchant UI shows "Awaiting customer payment").
```

- [ ] **Step 2: Update Playwright flows**

Find the e2e specs that place an order and expect it to reach ACCEPTED/CANCELLED (search: `grep -rln "place\|tracking\|accept" apps/web-customer/e2e apps/web-merchant/e2e 2>/dev/null`). In each such flow, after placing the order and landing on tracking, click the **Confirm payment** button (e.g. `page.getByRole("button", { name: /confirm payment/i }).click()`) before asserting progression / before the merchant accepts. If a merchant flow accepts an order, ensure the customer confirm happened first (otherwise the accept is `409`/disabled). Keep selectors consistent with the button label from Task 7.

- [ ] **Step 3: Add the confirm request to `requests.http`**

In `apps/write-api/requests.http`, near the accept/decline requests, add:
```http
### Phase 3c-iii — customer confirms payment (unblocks saga authorize)
POST {{baseUrl}}/orders/{{orderId}}/confirm-payment
Authorization: Bearer {{loginCustomer.response.body.$.accessToken}}
```

- [ ] **Step 4: Full backend verification**

Run (infra up, `register:schemas` done, payments running):
```bash
pnpm jest packages/contracts packages/shared apps/saga-worker apps/write-api -- --silent
```
Expected: PASS — contracts, shared, saga (unit + e2e incl. timeout), write-api (confirm + accept gate). Note: other read-api integration suites are unaffected by this slice.

- [ ] **Step 5: web-shared + frontend typechecks**

Run:
```bash
pnpm --filter @flashbite/web-shared test
pnpm --filter web-customer exec tsc --noEmit
pnpm --filter web-merchant exec tsc --noEmit
```
Expected: PASS for all.

- [ ] **Step 6: Commit**

```bash
git add docs/ARCHITECTURE.md apps/write-api/requests.http apps/web-customer/e2e apps/web-merchant/e2e
git commit -m "docs+e2e: payment confirmation gate + Playwright confirm step (3c-iii)"
```

---

## Manual smoke test (after #24 merges)

Full plane running (`infra:up`, `register:schemas`, all order-plane workers + `dev:payments` + `dev:write-api` + `dev:read-api` + `dev:web-customer` + `dev:web-merchant`):

1. Place an order → tracking shows **Confirm payment €X** and no payment status; the merchant sheet shows **Awaiting customer payment** (Accept/Decline hidden).
2. Click Confirm → tracking shows **Payment: Authorized**; the merchant can now Accept/Decline.
3. Merchant accepts → **Payment: Paid** / order ACCEPTED.
4. Place an order and never confirm → after `PAYMENT_CONFIRM_TIMEOUT_SECONDS` it cancels with **Payment not confirmed**; no payment row.
5. Place an order at/above `AUTH_DECLINE_THRESHOLD`, confirm → **Payment failed** (PAYMENT_FAILED).

---

## Self-review checklist (controller runs before dispatch)

- **Spec coverage:** confirm gate (T3); timeout cancel (T3/T4); customer endpoint (T5); merchant 409 gate (T5); merchant UI read-only (T8); customer button (T7); web-shared client+label (T6); config (T2); contracts (T1); docs+e2e (T9). ✓
- **Type consistency:** `OrderLifecycleArgs.confirmSeconds` (T3) added at every start site — `main.ts` (T3) + all e2e args (T4) + write-api accept e2e (T5). `confirmPaymentSignal` exported from `workflows.ts` (T3) and imported in unit (T3) + e2e (T4). `PAYMENT_STATUS.AUTHORIZED` gate (T5) matches the contracts enum. ✓
- **No placeholders:** every code/test step has full content. ✓
