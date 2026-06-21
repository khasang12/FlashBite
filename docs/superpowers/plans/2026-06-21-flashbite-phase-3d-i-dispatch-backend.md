# Phase 3d-i — Driver Dispatch Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `OrderAccepted`, run a `driverDispatchWorkflow` that offers the job to the nearest online/idle driver with a re-offer-on-reject loop, drives `OFFERED → DISPATCHED → PICKED_UP → DELIVERED` (or `FAILED`) on a new event-sourced `DriverDispatch` aggregate, and exposes the dispatch read path. Backend only.

**Architecture:** New `DriverDispatch` aggregate (`aggregateId = dispatch:<orderId>`) on a new `dispatch-events` Kafka topic (Avro) with its own projection/read model. A second Temporal workflow + activities + Kafka consumer added to the existing `saga-worker`. Availability via Redis online + busy sets ∩ geo. Driver commands signal the workflow from write-api; online toggle + dispatch reads on read-api.

**Tech Stack:** Temporal (`@temporalio/workflow`, `TestWorkflowEnvironment`), NestJS 10.4.4 (write-api/read-api), Prisma/Postgres (event store), MongoDB (read model), Redis Cluster (geo/sets), Avro + Schema Registry, `@flashbite/contracts`/`@flashbite/shared`/`@flashbite/messaging`, Jest.

**Branch:** `phase-3d-i-dispatch-backend` (created, off `main`).

---

## File Structure

**New files:**
- `packages/contracts/avro/{driver-offered,dispatch-accepted,order-picked-up,order-delivered,dispatch-failed}.avsc`
- `packages/shared/src/dispatch-aggregate.ts` (+ `dispatch-aggregate.spec.ts`)
- `apps/saga-worker/src/dispatch-workflow.ts` (+ `test/dispatch-workflow.spec.ts`)
- `apps/saga-worker/src/dispatch-activities.ts`
- `apps/saga-worker/test/dispatch.e2e-spec.ts`
- `apps/read-api/src/dispatch/{dispatch.controller.ts,dispatch-query.service.ts,dispatch.module.ts}` (+ `test/dispatch.e2e-spec.ts`)
- `apps/write-api/src/orders/dispatch.controller.ts` (+ `test/dispatch.e2e-spec.ts`)
- `apps/projection-worker/src/dispatch-projection.ts` (+ `test/dispatch-projection.spec.ts`)

**Modified files:**
- `packages/contracts/src/index.ts` (+ `contracts.spec.ts`)
- `packages/shared/src/aggregate-store.ts`, `packages/shared/src/index.ts`, `packages/shared/src/config.ts`
- `apps/saga-worker/src/workflows.ts` (re-export), `apps/saga-worker/src/main.ts`
- `apps/read-api/src/drivers/drivers.controller.ts`, `apps/read-api/src/app.module.ts`
- `apps/write-api/src/orders/orders.module.ts`
- `apps/projection-worker/src/main.ts`, `apps/projection-worker/src/rebuild.ts`
- `.env.example`, `docs/ARCHITECTURE.md`, `apps/write-api/requests.http`

---

## Task 1: Contracts — dispatch vocabulary + Avro schemas

**Files:** Modify `packages/contracts/src/index.ts`, `packages/contracts/src/contracts.spec.ts`; create 5 `.avsc` under `packages/contracts/avro/`.

- [ ] **Step 1: Add constants + types** to `packages/contracts/src/index.ts`.

Extend `AGGREGATE_TYPES`:
```ts
export const AGGREGATE_TYPES = {
  ORDER: "ORDER",
  DISPATCH: "DISPATCH",
} as const;
```
Extend `TOPICS`:
```ts
  DISPATCH_EVENTS: "dispatch-events",
```
Extend `EVENT_TYPES`:
```ts
  DRIVER_OFFERED: "DriverOffered",
  DISPATCH_ACCEPTED: "DispatchAccepted",
  ORDER_PICKED_UP: "OrderPickedUp",
  ORDER_DELIVERED: "OrderDelivered",
  DISPATCH_FAILED: "DispatchFailed",
```
Extend `READ_COLLECTIONS`:
```ts
  DISPATCHES: "dispatches",
```
Extend `CONSUMER_GROUPS`:
```ts
  DISPATCH_STARTER: "dispatch-starter",
  DISPATCH_PROJECTION: "dispatch-projection",
```
Add `SUBJECTS` entries (after the telemetry one):
```ts
  { eventType: EVENT_TYPES.DRIVER_OFFERED, topic: TOPICS.DISPATCH_EVENTS, recordName: "DriverOffered", avsc: "driver-offered.avsc" },
  { eventType: EVENT_TYPES.DISPATCH_ACCEPTED, topic: TOPICS.DISPATCH_EVENTS, recordName: "DispatchAccepted", avsc: "dispatch-accepted.avsc" },
  { eventType: EVENT_TYPES.ORDER_PICKED_UP, topic: TOPICS.DISPATCH_EVENTS, recordName: "OrderPickedUp", avsc: "order-picked-up.avsc" },
  { eventType: EVENT_TYPES.ORDER_DELIVERED, topic: TOPICS.DISPATCH_EVENTS, recordName: "OrderDelivered", avsc: "order-delivered.avsc" },
  { eventType: EVENT_TYPES.DISPATCH_FAILED, topic: TOPICS.DISPATCH_EVENTS, recordName: "DispatchFailed", avsc: "dispatch-failed.avsc" },
```
Add a new "Dispatch (Phase 3d)" section near the order-saga block:
```ts
// ---- Driver dispatch (Phase 3d) ----
export const DISPATCH_STATUS = {
  OFFERED: "OFFERED",
  DISPATCHED: "DISPATCHED",
  PICKED_UP: "PICKED_UP",
  DELIVERED: "DELIVERED",
  FAILED: "FAILED",
} as const;
export type DispatchStatus = (typeof DISPATCH_STATUS)[keyof typeof DISPATCH_STATUS];

export const DISPATCH_SAGA = {
  TASK_QUEUE: ORDER_SAGA.TASK_QUEUE, // same worker/queue, distinct workflow type
  WORKFLOW_TYPE: "driverDispatchWorkflow",
  ACCEPT_SIGNAL: "dispatchAccept",
  REJECT_SIGNAL: "dispatchReject",
  PICKUP_SIGNAL: "dispatchPickup",
  DELIVER_SIGNAL: "dispatchDeliver",
} as const;

export const DISPATCH_FAIL_REASONS = { NO_DRIVERS_AVAILABLE: "NO_DRIVERS_AVAILABLE" } as const;

export interface DriverOfferedPayload { orderId: string; driverId: string }
export interface DispatchAcceptedPayload { orderId: string; driverId: string }
export interface OrderPickedUpPayload { orderId: string }
export interface OrderDeliveredPayload { orderId: string }
export interface DispatchFailedPayload { orderId: string; reason: string }

/** Read-side dispatch projection. */
export interface DispatchView {
  tenantId: string;
  orderId: string;
  status: DispatchStatus;
  driverId?: string;        // assigned (after accept)
  offeredDriverId?: string; // currently/last offered
  reason?: string;          // on FAILED
  version: number;
  updatedAt: string;
}

/** Dispatch aggregate id — namespaced so it never collides with the Order stream (same event_store). */
export function dispatchAggregateId(orderId: string): string { return `dispatch:${orderId}`; }
/** Redis set of online (opted-in) drivers, hash-tagged per tenant. */
export function driverOnlineKey(tenantId: string): string { return tenantKey(tenantId, "drivers", "online"); }
/** Redis set of drivers on an active dispatch, hash-tagged per tenant. */
export function driverBusyKey(tenantId: string): string { return tenantKey(tenantId, "drivers", "busy"); }
```

- [ ] **Step 2: Create the 5 Avro schemas** under `packages/contracts/avro/` (namespace `com.flashbite.events`, record name = `recordName` above):

`driver-offered.avsc`:
```json
{ "type": "record", "name": "DriverOffered", "namespace": "com.flashbite.events", "fields": [ { "name": "orderId", "type": "string" }, { "name": "driverId", "type": "string" } ] }
```
`dispatch-accepted.avsc`:
```json
{ "type": "record", "name": "DispatchAccepted", "namespace": "com.flashbite.events", "fields": [ { "name": "orderId", "type": "string" }, { "name": "driverId", "type": "string" } ] }
```
`order-picked-up.avsc`:
```json
{ "type": "record", "name": "OrderPickedUp", "namespace": "com.flashbite.events", "fields": [ { "name": "orderId", "type": "string" } ] }
```
`order-delivered.avsc`:
```json
{ "type": "record", "name": "OrderDelivered", "namespace": "com.flashbite.events", "fields": [ { "name": "orderId", "type": "string" } ] }
```
`dispatch-failed.avsc`:
```json
{ "type": "record", "name": "DispatchFailed", "namespace": "com.flashbite.events", "fields": [ { "name": "orderId", "type": "string" }, { "name": "reason", "type": "string" } ] }
```

- [ ] **Step 3: Extend `contracts.spec.ts`** — add assertions for the new `AGGREGATE_TYPES.DISPATCH`, `TOPICS.DISPATCH_EVENTS`, each new `EVENT_TYPES.*`, `DISPATCH_STATUS`, `DISPATCH_SAGA`, and `dispatchAggregateId("o1") === "dispatch:o1"`. Match the existing `toBe`/`toEqual` assertion style; if a `SUBJECTS` length/shape is asserted, update it. Do not weaken existing assertions.

- [ ] **Step 4: Run** `pnpm jest packages/contracts -- --silent` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/contracts/src/index.ts packages/contracts/src/contracts.spec.ts packages/contracts/avro
git commit -m "feat(contracts): dispatch events, status, subjects, keys (3d-i)"
```

---

## Task 2: Shared — topic-param append + DriverDispatch aggregate

**Files:** Modify `packages/shared/src/aggregate-store.ts`, `packages/shared/src/index.ts`; create `packages/shared/src/dispatch-aggregate.ts` + `packages/shared/src/dispatch-aggregate.spec.ts`.

- [ ] **Step 1: Generalize `appendWithExpectedVersion` with a `topic` param.**

In `packages/shared/src/aggregate-store.ts`, add `topic?: string;` to `AppendArgs`, and in the outbox `create`, replace `topic: TOPICS.ORDER_EVENTS,` with:
```ts
          topic: args.topic ?? TOPICS.ORDER_EVENTS,
```
(`TOPICS` is already imported. Default preserves all existing order callers unchanged.)

- [ ] **Step 2: Write the failing dispatch-aggregate spec.** Create `packages/shared/src/dispatch-aggregate.spec.ts`:
```ts
import {
  foldDispatch, offer, acceptOffer, pickup, deliver, fail,
  INITIAL_DISPATCH_STATE, InvalidTransitionError,
} from "./dispatch-aggregate";
import { EVENT_TYPES, DISPATCH_STATUS } from "@flashbite/contracts";

const ev = (eventType: string, payload: unknown) => ({ eventType, payload, version: 1 });

describe("dispatch-aggregate", () => {
  it("folds the happy path to DELIVERED", () => {
    let s = INITIAL_DISPATCH_STATE;
    s = foldDispatch(s, ev(EVENT_TYPES.DRIVER_OFFERED, { orderId: "o1", driverId: "d1" }));
    expect(s.status).toBe(DISPATCH_STATUS.OFFERED);
    expect(s.offeredDriverId).toBe("d1");
    s = foldDispatch(s, ev(EVENT_TYPES.DISPATCH_ACCEPTED, { orderId: "o1", driverId: "d1" }));
    expect(s.status).toBe(DISPATCH_STATUS.DISPATCHED);
    expect(s.driverId).toBe("d1");
    s = foldDispatch(s, ev(EVENT_TYPES.ORDER_PICKED_UP, { orderId: "o1" }));
    expect(s.status).toBe(DISPATCH_STATUS.PICKED_UP);
    s = foldDispatch(s, ev(EVENT_TYPES.ORDER_DELIVERED, { orderId: "o1" }));
    expect(s.status).toBe(DISPATCH_STATUS.DELIVERED);
  });

  it("offer is allowed from null and from OFFERED (re-offer)", () => {
    expect(offer(INITIAL_DISPATCH_STATE, "o1", "d1")).toEqual({ orderId: "o1", driverId: "d1" });
    const offered = foldDispatch(INITIAL_DISPATCH_STATE, ev(EVENT_TYPES.DRIVER_OFFERED, { orderId: "o1", driverId: "d1" }));
    expect(offer(offered, "o1", "d2")).toEqual({ orderId: "o1", driverId: "d2" });
  });

  it("acceptOffer requires OFFERED and matching driver", () => {
    const offered = foldDispatch(INITIAL_DISPATCH_STATE, ev(EVENT_TYPES.DRIVER_OFFERED, { orderId: "o1", driverId: "d1" }));
    expect(acceptOffer(offered, "o1", "d1")).toEqual({ orderId: "o1", driverId: "d1" });
    expect(() => acceptOffer(offered, "o1", "dX")).toThrow(InvalidTransitionError);
    expect(() => acceptOffer(INITIAL_DISPATCH_STATE, "o1", "d1")).toThrow(InvalidTransitionError);
  });

  it("pickup requires DISPATCHED; deliver requires PICKED_UP", () => {
    let s = foldDispatch(INITIAL_DISPATCH_STATE, ev(EVENT_TYPES.DRIVER_OFFERED, { orderId: "o1", driverId: "d1" }));
    s = foldDispatch(s, ev(EVENT_TYPES.DISPATCH_ACCEPTED, { orderId: "o1", driverId: "d1" }));
    expect(pickup(s, "o1")).toEqual({ orderId: "o1" });
    expect(() => deliver(s, "o1")).toThrow(InvalidTransitionError);
    s = foldDispatch(s, ev(EVENT_TYPES.ORDER_PICKED_UP, { orderId: "o1" }));
    expect(deliver(s, "o1")).toEqual({ orderId: "o1" });
  });

  it("fail is allowed while not yet terminal", () => {
    expect(fail(INITIAL_DISPATCH_STATE, "o1", "NO_DRIVERS_AVAILABLE")).toEqual({ orderId: "o1", reason: "NO_DRIVERS_AVAILABLE" });
    const delivered = foldDispatch(
      foldDispatch(
        foldDispatch(
          foldDispatch(INITIAL_DISPATCH_STATE, ev(EVENT_TYPES.DRIVER_OFFERED, { orderId: "o1", driverId: "d1" })),
          ev(EVENT_TYPES.DISPATCH_ACCEPTED, { orderId: "o1", driverId: "d1" })),
        ev(EVENT_TYPES.ORDER_PICKED_UP, { orderId: "o1" })),
      ev(EVENT_TYPES.ORDER_DELIVERED, { orderId: "o1" }));
    expect(() => fail(delivered, "o1", "x")).toThrow(InvalidTransitionError);
  });
});
```

- [ ] **Step 3: Run** `pnpm jest packages/shared/src/dispatch-aggregate.spec.ts -- --silent` → FAIL (module missing).

- [ ] **Step 4: Implement** `packages/shared/src/dispatch-aggregate.ts`:
```ts
import {
  EVENT_TYPES, DISPATCH_STATUS, type DispatchStatus,
  type DriverOfferedPayload, type DispatchAcceptedPayload,
  type OrderPickedUpPayload, type OrderDeliveredPayload, type DispatchFailedPayload,
} from "@flashbite/contracts";
import { InvalidTransitionError } from "./order-aggregate";

export { InvalidTransitionError };

export interface DispatchState {
  status: DispatchStatus | null; // null = not started
  offeredDriverId?: string;
  driverId?: string;
  reason?: string;
}

export const INITIAL_DISPATCH_STATE: DispatchState = { status: null };

const TERMINAL: DispatchStatus[] = [DISPATCH_STATUS.DELIVERED, DISPATCH_STATUS.FAILED];

export function foldDispatch(state: DispatchState, event: { eventType: string; payload: unknown }): DispatchState {
  switch (event.eventType) {
    case EVENT_TYPES.DRIVER_OFFERED:
      return { ...state, status: DISPATCH_STATUS.OFFERED, offeredDriverId: (event.payload as DriverOfferedPayload).driverId };
    case EVENT_TYPES.DISPATCH_ACCEPTED:
      return { ...state, status: DISPATCH_STATUS.DISPATCHED, driverId: (event.payload as DispatchAcceptedPayload).driverId };
    case EVENT_TYPES.ORDER_PICKED_UP:
      return { ...state, status: DISPATCH_STATUS.PICKED_UP };
    case EVENT_TYPES.ORDER_DELIVERED:
      return { ...state, status: DISPATCH_STATUS.DELIVERED };
    case EVENT_TYPES.DISPATCH_FAILED:
      return { ...state, status: DISPATCH_STATUS.FAILED, reason: (event.payload as DispatchFailedPayload).reason };
    default:
      return state;
  }
}

/** offer: allowed from null or OFFERED (re-offer to the next driver). */
export function offer(state: DispatchState, orderId: string, driverId: string): DriverOfferedPayload {
  if (state.status !== null && state.status !== DISPATCH_STATUS.OFFERED) {
    throw new InvalidTransitionError(`cannot offer in status ${String(state.status)}`);
  }
  return { orderId, driverId };
}

/** acceptOffer: requires OFFERED and the accepting driver to be the offered one. */
export function acceptOffer(state: DispatchState, orderId: string, driverId: string): DispatchAcceptedPayload {
  if (state.status !== DISPATCH_STATUS.OFFERED || state.offeredDriverId !== driverId) {
    throw new InvalidTransitionError(`cannot accept in status ${String(state.status)} by ${driverId}`);
  }
  return { orderId, driverId };
}

export function pickup(state: DispatchState, orderId: string): OrderPickedUpPayload {
  if (state.status !== DISPATCH_STATUS.DISPATCHED) throw new InvalidTransitionError(`cannot pick up in status ${String(state.status)}`);
  return { orderId };
}

export function deliver(state: DispatchState, orderId: string): OrderDeliveredPayload {
  if (state.status !== DISPATCH_STATUS.PICKED_UP) throw new InvalidTransitionError(`cannot deliver in status ${String(state.status)}`);
  return { orderId };
}

export function fail(state: DispatchState, orderId: string, reason: string): DispatchFailedPayload {
  if (state.status !== null && TERMINAL.includes(state.status)) {
    throw new InvalidTransitionError(`cannot fail in terminal status ${String(state.status)}`);
  }
  return { orderId, reason };
}
```

- [ ] **Step 5: Export from the barrel.** In `packages/shared/src/index.ts`, add:
```ts
export * from "./dispatch-aggregate";
```
(Confirm it doesn't double-export `InvalidTransitionError` ambiguously — `order-aggregate` exports the class; `dispatch-aggregate` re-exports the same symbol. If the barrel does `export *` from both, TS will error on the duplicate. **Fix:** in `dispatch-aggregate.ts` remove the `export { InvalidTransitionError };` re-export and instead `import` it for internal use only; consumers get it from `order-aggregate`. Adjust Step 4 accordingly if the barrel uses `export *` for order-aggregate.)

- [ ] **Step 6: Run** `pnpm jest packages/shared -- --silent` → PASS (dispatch-aggregate + existing shared specs).

- [ ] **Step 7: Commit**
```bash
git add packages/shared/src/aggregate-store.ts packages/shared/src/dispatch-aggregate.ts packages/shared/src/dispatch-aggregate.spec.ts packages/shared/src/index.ts
git commit -m "feat(shared): DriverDispatch aggregate + topic-param append (3d-i)"
```

---

## Task 3: saga-worker — dispatch workflow + unit tests

**Files:** Create `apps/saga-worker/src/dispatch-workflow.ts`, `apps/saga-worker/test/dispatch-workflow.spec.ts`; modify `apps/saga-worker/src/workflows.ts`.

- [ ] **Step 1: Write the workflow.** Create `apps/saga-worker/src/dispatch-workflow.ts`:
```ts
import { proxyActivities, condition, defineSignal, setHandler } from "@temporalio/workflow";
import { DISPATCH_SAGA, DISPATCH_STATUS, DISPATCH_FAIL_REASONS } from "@flashbite/contracts";
import type { DispatchActivities } from "./dispatch-activities";

export const dispatchAcceptSignal = defineSignal<[string]>(DISPATCH_SAGA.ACCEPT_SIGNAL);
export const dispatchRejectSignal = defineSignal<[string]>(DISPATCH_SAGA.REJECT_SIGNAL);
export const dispatchPickupSignal = defineSignal<[string]>(DISPATCH_SAGA.PICKUP_SIGNAL);
export const dispatchDeliverSignal = defineSignal<[string]>(DISPATCH_SAGA.DELIVER_SIGNAL);

const {
  selectNearestAvailableDriverActivity, markBusyActivity, clearBusyActivity,
  recordDriverOfferedActivity, recordDispatchAcceptedActivity,
  recordOrderPickedUpActivity, recordOrderDeliveredActivity, recordDispatchFailedActivity,
} = proxyActivities<DispatchActivities>({ startToCloseTimeout: "1 minute" });

export interface DispatchArgs {
  tenantId: string;
  orderId: string;
  offerTimeoutSeconds: number;
  maxOffers: number;
}

/**
 * Offer to the nearest online/idle driver; on reject/timeout re-offer the next-nearest
 * (never the same driver twice). Accept -> pickup -> deliver. Exhaustion -> DispatchFailed.
 * Deterministic: all I/O is in activities; only the offered/assigned driver's signals advance.
 */
export async function driverDispatchWorkflow(args: DispatchArgs): Promise<string> {
  let accepted: string | undefined;
  let rejected: string | undefined;
  let pickedUp = false;
  let delivered = false;
  setHandler(dispatchAcceptSignal, (d) => { accepted = d; });
  setHandler(dispatchRejectSignal, (d) => { rejected = d; });
  setHandler(dispatchPickupSignal, () => { pickedUp = true; });
  setHandler(dispatchDeliverSignal, () => { delivered = true; });

  const tried: string[] = [];
  for (let i = 0; i < args.maxOffers; i++) {
    const candidate = await selectNearestAvailableDriverActivity(args.tenantId, tried);
    if (!candidate) {
      await recordDispatchFailedActivity(args.tenantId, args.orderId, DISPATCH_FAIL_REASONS.NO_DRIVERS_AVAILABLE);
      return DISPATCH_STATUS.FAILED;
    }
    tried.push(candidate);
    accepted = undefined; rejected = undefined;
    await recordDriverOfferedActivity(args.tenantId, args.orderId, candidate);

    await condition(() => accepted === candidate || rejected === candidate, `${args.offerTimeoutSeconds}s`);
    if (accepted !== candidate) continue; // reject or timeout -> next-nearest

    await markBusyActivity(args.tenantId, candidate);
    await recordDispatchAcceptedActivity(args.tenantId, args.orderId, candidate);
    await condition(() => pickedUp);
    await recordOrderPickedUpActivity(args.tenantId, args.orderId);
    await condition(() => delivered);
    await recordOrderDeliveredActivity(args.tenantId, args.orderId);
    await clearBusyActivity(args.tenantId, candidate);
    return DISPATCH_STATUS.DELIVERED;
  }
  await recordDispatchFailedActivity(args.tenantId, args.orderId, DISPATCH_FAIL_REASONS.NO_DRIVERS_AVAILABLE);
  return DISPATCH_STATUS.FAILED;
}
```

- [ ] **Step 2: Make the workflow part of the worker bundle.** In `apps/saga-worker/src/workflows.ts`, append:
```ts
export { driverDispatchWorkflow } from "./dispatch-workflow";
```
(The worker's `workflowsPath` points at `workflows.ts`; re-exporting pulls `driverDispatchWorkflow` into the same bundle.)

- [ ] **Step 3: Write the unit test.** Create `apps/saga-worker/test/dispatch-workflow.spec.ts`:
```ts
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import path from "node:path";
import {
  driverDispatchWorkflow, dispatchAcceptSignal, dispatchRejectSignal,
  dispatchPickupSignal, dispatchDeliverSignal,
} from "../src/dispatch-workflow";

describe("driverDispatchWorkflow", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120000);
  afterAll(async () => { await env?.teardown(); });

  const calls: string[] = [];
  let queue: Array<string | null> = []; // candidates returned per selection call
  const stub = {
    async selectNearestAvailableDriverActivity(_t: string, tried: string[]) {
      calls.push(`select:[${tried.join(",")}]`);
      return queue.shift() ?? null;
    },
    async markBusyActivity(_t: string, d: string) { calls.push(`busy:${d}`); },
    async clearBusyActivity(_t: string, d: string) { calls.push(`idle:${d}`); },
    async recordDriverOfferedActivity(_t: string, _o: string, d: string) { calls.push(`offered:${d}`); },
    async recordDispatchAcceptedActivity(_t: string, _o: string, d: string) { calls.push(`accepted:${d}`); },
    async recordOrderPickedUpActivity() { calls.push("pickedup"); },
    async recordOrderDeliveredActivity() { calls.push("delivered"); },
    async recordDispatchFailedActivity(_t: string, _o: string, reason: string) { calls.push(`failed:${reason}`); },
  };

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: "test-dispatch",
      workflowsPath: path.join(__dirname, "../src/dispatch-workflow.ts"), activities: stub,
    });
    return worker.runUntil(fn);
  }
  const args = (orderId: string) => ({ tenantId: "berlin", orderId, offerTimeoutSeconds: 30, maxOffers: 5 });

  it("accept -> pickup -> deliver = DELIVERED", async () => {
    calls.length = 0; queue = ["d1"];
    const result = await run(async () => {
      const h = await env.client.workflow.start(driverDispatchWorkflow, { taskQueue: "test-dispatch", workflowId: `disp-accept-${Date.now()}`, args: [args("o1")] });
      await h.signal(dispatchAcceptSignal, "d1");
      await h.signal(dispatchPickupSignal, "d1");
      await h.signal(dispatchDeliverSignal, "d1");
      return h.result();
    });
    expect(result).toBe("DELIVERED");
    expect(calls).toEqual(["select:[]", "offered:d1", "busy:d1", "accepted:d1", "pickedup", "delivered", "idle:d1"]);
  });

  it("reject re-offers the next-nearest, never the same driver", async () => {
    calls.length = 0; queue = ["d1", "d2"];
    const result = await run(async () => {
      const h = await env.client.workflow.start(driverDispatchWorkflow, { taskQueue: "test-dispatch", workflowId: `disp-reoffer-${Date.now()}`, args: [args("o2")] });
      await h.signal(dispatchRejectSignal, "d1");
      await h.signal(dispatchAcceptSignal, "d2");
      await h.signal(dispatchPickupSignal, "d2");
      await h.signal(dispatchDeliverSignal, "d2");
      return h.result();
    });
    expect(result).toBe("DELIVERED");
    expect(calls).toEqual(["select:[]", "offered:d1", "select:[d1]", "offered:d2", "busy:d2", "accepted:d2", "pickedup", "delivered", "idle:d2"]);
  });

  it("no candidate -> DispatchFailed", async () => {
    calls.length = 0; queue = [null];
    const result = await run(async () => {
      const h = await env.client.workflow.start(driverDispatchWorkflow, { taskQueue: "test-dispatch", workflowId: `disp-fail-${Date.now()}`, args: [args("o3")] });
      return h.result();
    });
    expect(result).toBe("FAILED");
    expect(calls).toEqual(["select:[]", "failed:NO_DRIVERS_AVAILABLE"]);
  });

  it("all offers time out -> DispatchFailed (time-skipped)", async () => {
    calls.length = 0; queue = ["d1", "d2", "d3", "d4", "d5"];
    const result = await run(async () => {
      const h = await env.client.workflow.start(driverDispatchWorkflow, { taskQueue: "test-dispatch", workflowId: `disp-timeout-${Date.now()}`, args: [args("o4")] });
      return h.result(); // never signal -> each offer times out
    });
    expect(result).toBe("FAILED");
    expect(calls.filter((c) => c.startsWith("offered")).length).toBe(5);
    expect(calls.at(-1)).toBe("failed:NO_DRIVERS_AVAILABLE");
  });
});
```

- [ ] **Step 4: Run** `pnpm jest apps/saga-worker/test/dispatch-workflow.spec.ts -- --silent` → PASS (4 cases; time-skipping server handles the timeout case).

- [ ] **Step 5: Commit**
```bash
git add apps/saga-worker/src/dispatch-workflow.ts apps/saga-worker/src/workflows.ts apps/saga-worker/test/dispatch-workflow.spec.ts
git commit -m "feat(saga): driverDispatchWorkflow re-offer loop + unit tests (3d-i)"
```

---

## Task 4: saga-worker — dispatch activities + OrderAccepted starter

**Files:** Create `apps/saga-worker/src/dispatch-activities.ts`; modify `apps/saga-worker/src/main.ts`.

- [ ] **Step 1: Implement the activities.** Create `apps/saga-worker/src/dispatch-activities.ts`:
```ts
import type { PrismaClient } from "@prisma/client";
import type { Cluster } from "ioredis";
import {
  loadAggregate, appendWithExpectedVersion,
  foldDispatch, offer, acceptOffer, pickup, deliver, fail, INITIAL_DISPATCH_STATE, InvalidTransitionError,
} from "@flashbite/shared";
import {
  AGGREGATE_TYPES, EVENT_TYPES, TOPICS, CITY_CENTERS,
  dispatchAggregateId, driverGeoKey, driverOnlineKey, driverBusyKey, type Tenant,
} from "@flashbite/contracts";

/** Dispatch activities — Redis-backed selection/busy + event-sourced appends to the dispatch stream. */
export function createDispatchActivities(prisma: PrismaClient, redis: Cluster) {
  async function append(tenantId: string, orderId: string, eventType: string, build: (s: ReturnType<typeof foldDispatch>) => unknown) {
    const aggregateId = dispatchAggregateId(orderId);
    const { state, version } = await loadAggregate(prisma, { tenantId, aggregateId }, foldDispatch, INITIAL_DISPATCH_STATE);
    let payload;
    try { payload = build(state); } catch (e) { if (e instanceof InvalidTransitionError) return; throw e; } // benign no-op on re-delivery
    await appendWithExpectedVersion(prisma, {
      tenantId, aggregateType: AGGREGATE_TYPES.DISPATCH, aggregateId,
      expectedVersion: version, eventType, payload, topic: TOPICS.DISPATCH_EVENTS,
    });
  }

  return {
    async selectNearestAvailableDriverActivity(tenantId: string, exclude: string[]): Promise<string | null> {
      const center = CITY_CENTERS[tenantId as Tenant];
      if (!center) return null;
      const rows = (await redis.geosearch(
        driverGeoKey(tenantId), "FROMLONLAT", String(center.lng), String(center.lat),
        "BYRADIUS", "50", "km", "ASC",
      )) as string[];
      const ex = new Set(exclude);
      for (const driverId of rows) {
        if (ex.has(driverId)) continue;
        const online = await redis.sismember(driverOnlineKey(tenantId), driverId);
        if (!online) continue;
        const busy = await redis.sismember(driverBusyKey(tenantId), driverId);
        if (busy) continue;
        return driverId;
      }
      return null;
    },
    async markBusyActivity(tenantId: string, driverId: string): Promise<void> {
      await redis.sadd(driverBusyKey(tenantId), driverId);
    },
    async clearBusyActivity(tenantId: string, driverId: string): Promise<void> {
      await redis.srem(driverBusyKey(tenantId), driverId);
    },
    async recordDriverOfferedActivity(tenantId: string, orderId: string, driverId: string): Promise<void> {
      await append(tenantId, orderId, EVENT_TYPES.DRIVER_OFFERED, (s) => offer(s, orderId, driverId));
    },
    async recordDispatchAcceptedActivity(tenantId: string, orderId: string, driverId: string): Promise<void> {
      await append(tenantId, orderId, EVENT_TYPES.DISPATCH_ACCEPTED, (s) => acceptOffer(s, orderId, driverId));
    },
    async recordOrderPickedUpActivity(tenantId: string, orderId: string): Promise<void> {
      await append(tenantId, orderId, EVENT_TYPES.ORDER_PICKED_UP, (s) => pickup(s, orderId));
    },
    async recordOrderDeliveredActivity(tenantId: string, orderId: string): Promise<void> {
      await append(tenantId, orderId, EVENT_TYPES.ORDER_DELIVERED, (s) => deliver(s, orderId));
    },
    async recordDispatchFailedActivity(tenantId: string, orderId: string, reason: string): Promise<void> {
      await append(tenantId, orderId, EVENT_TYPES.DISPATCH_FAILED, (s) => fail(s, orderId, reason));
    },
  };
}

export type DispatchActivities = ReturnType<typeof createDispatchActivities>;
```
(Note: `redis.geosearch` returns ids only here — no `WITHDIST`/`WITHCOORD` — so the cast is `string[]`. `CITY_CENTERS`/`GeoPoint` provide `{lng,lat}`; confirm the property names match the contract and adjust if it's `{lat,lng}`.)

- [ ] **Step 2: Register activities + start workflow on OrderAccepted.** In `apps/saga-worker/src/main.ts`:
  - Imports: add `EVENT_TYPES` (already imports some contracts), `RedisService` from `@flashbite/shared`, `createDispatchActivities` from `./dispatch-activities`, and `DISPATCH_SAGA` from `@flashbite/contracts`.
  - In `startSagaWorker`, build a Redis cluster and merge dispatch activities into the worker:
    ```ts
    const redis = new RedisService();
    const worker = await Worker.create({
      connection, namespace: "default", taskQueue: ORDER_SAGA.TASK_QUEUE,
      workflowsPath: path.join(__dirname, "workflows.ts"),
      activities: { ...createActivities(prisma), ...createDispatchActivities(prisma, redis.cluster) },
    });
    ```
    and in the returned `stop`, add `await redis.cluster.quit();` before disconnecting.
  - Add a `startDispatchConsumer` (mirror `startOrderConsumer`) that subscribes to `TOPICS.ORDER_EVENTS`, and on `envelope.eventType === EVENT_TYPES.ORDER_ACCEPTED` starts the dispatch workflow:
    ```ts
    await temporal.client.workflow.start(DISPATCH_SAGA.WORKFLOW_TYPE, {
      taskQueue: DISPATCH_SAGA.TASK_QUEUE,
      workflowId: `dispatch:${envelope.tenantId}:${p.orderId}`,
      workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
      args: [{ tenantId: envelope.tenantId, orderId: p.orderId, offerTimeoutSeconds, maxOffers }],
    });
    ```
    (use `OrderAcceptedPayload` for `p`; guard `already started` like the existing starter). Wire it in `main()` with a new kafka consumer on `CONSUMER_GROUPS.DISPATCH_STARTER`, passing `config.dispatchOfferTimeoutSeconds` and `config.dispatchMaxOffers`. Stop it in shutdown.

- [ ] **Step 3: Typecheck** the worker compiles: `pnpm jest apps/saga-worker/test/dispatch-workflow.spec.ts -- --silent` still PASS, and `node -e "require('@swc-node/register'); require('./apps/saga-worker/src/main.ts')"` is **not** needed — instead rely on Task 5's e2e to exercise the runtime. (A `tsc` typecheck isn't configured per-app; the e2e + jest ts-jest compile catch type errors.)

- [ ] **Step 4: Commit**
```bash
git add apps/saga-worker/src/dispatch-activities.ts apps/saga-worker/src/main.ts
git commit -m "feat(saga): dispatch activities + OrderAccepted starter (3d-i)"
```

---

## Task 5: saga-worker — dispatch e2e (live)

**Files:** Create `apps/saga-worker/test/dispatch.e2e-spec.ts`.

> Live Temporal + Postgres + Redis. Infra up. Boots the real saga worker; seeds a driver into the geo + online sets; starts the workflow directly and signals it through to DELIVERED.

- [ ] **Step 1: Write the e2e.** Create `apps/saga-worker/test/dispatch.e2e-spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, RedisService, TemporalHandle } from "@flashbite/shared";
import { CITY_CENTERS, driverGeoKey, driverOnlineKey, driverBusyKey, dispatchAggregateId } from "@flashbite/contracts";
import { startSagaWorker, SagaWorkerHandle } from "../src/main";
import {
  driverDispatchWorkflow, dispatchAcceptSignal, dispatchPickupSignal, dispatchDeliverSignal,
} from "../src/dispatch-workflow";

describe("driver dispatch (e2e: live Temporal + Postgres + Redis)", () => {
  const prisma = new PrismaClient();
  const redis = new RedisService();
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
    await redis.cluster.quit();
    await prisma.$disconnect();
  });

  it("offered driver accepts -> pickup -> deliver records the full dispatch stream", async () => {
    const driverId = `drv-${randomUUID().slice(0, 8)}`;
    const orderId = randomUUID();
    const c = CITY_CENTERS.berlin;
    await redis.cluster.geoadd(driverGeoKey("berlin"), c.lng, c.lat, driverId);
    await redis.cluster.sadd(driverOnlineKey("berlin"), driverId);

    const handle = await temporal.client.workflow.start(driverDispatchWorkflow, {
      taskQueue: "order-lifecycle",
      workflowId: `dispatch:berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, offerTimeoutSeconds: 30, maxOffers: 5 }],
    });
    // wait until the offer is recorded, then accept as the offered driver
    await new Promise((r) => setTimeout(r, 1500));
    await handle.signal(dispatchAcceptSignal, driverId);
    await handle.signal(dispatchPickupSignal, driverId);
    await handle.signal(dispatchDeliverSignal, driverId);
    const result = await handle.result();
    expect(result).toBe("DELIVERED");

    const events = await prisma.eventStore.findMany({
      where: { tenantId: "berlin", aggregateId: dispatchAggregateId(orderId) }, orderBy: { version: "asc" },
    });
    expect(events.map((e) => e.eventType)).toEqual(["DriverOffered", "DispatchAccepted", "OrderPickedUp", "OrderDelivered"]);
    expect(await redis.cluster.sismember(driverBusyKey("berlin"), driverId)).toBe(0); // cleared on deliver

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${dispatchAggregateId(orderId)}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: dispatchAggregateId(orderId) } });
    await redis.cluster.srem(driverGeoKey("berlin"), driverId);
    await redis.cluster.srem(driverOnlineKey("berlin"), driverId);
  }, 60000);
});
```

- [ ] **Step 2: Run** `pnpm jest apps/saga-worker/test/dispatch.e2e-spec.ts -- --silent` (infra up; only fresh saga workers running) → PASS.

- [ ] **Step 3: Commit**
```bash
git add apps/saga-worker/test/dispatch.e2e-spec.ts
git commit -m "test(saga): dispatch e2e accept->deliver stream (3d-i)"
```

---

## Task 6: read-api — online toggle + dispatch reads

**Files:** Modify `apps/read-api/src/drivers/drivers.controller.ts`, `apps/read-api/src/app.module.ts`; create `apps/read-api/src/dispatch/{dispatch-query.service.ts,dispatch.controller.ts,dispatch.module.ts}`, `apps/read-api/test/dispatch.e2e-spec.ts`.

- [ ] **Step 1: Online/offline on the drivers controller.** In `apps/read-api/src/drivers/drivers.controller.ts` add imports (`Roles`, `ROLES`, `driverOnlineKey`) and routes (driver-role, tenant from JWT):
```ts
  @Post(":driverId/online")
  @HttpCode(202)
  @Roles(ROLES.DRIVER)
  async goOnline(@Param("driverId") driverId: string): Promise<{ driverId: string; online: true }> {
    await this.redis.cluster.sadd(driverOnlineKey(currentTenant()), driverId);
    return { driverId, online: true };
  }

  @Post(":driverId/offline")
  @HttpCode(202)
  @Roles(ROLES.DRIVER)
  async goOffline(@Param("driverId") driverId: string): Promise<{ driverId: string; online: false }> {
    await this.redis.cluster.srem(driverOnlineKey(currentTenant()), driverId);
    return { driverId, online: false };
  }
```
(`Roles` from `@flashbite/tenant-context`; `ROLES` + `driverOnlineKey` from `@flashbite/contracts`. `ROLES.DRIVER === "driver"` already exists.)

- [ ] **Step 2: Dispatch query service.** Create `apps/read-api/src/dispatch/dispatch-query.service.ts`:
```ts
import { Injectable } from "@nestjs/common";
import { MongoService } from "@flashbite/shared";
import { READ_COLLECTIONS, type DispatchView } from "@flashbite/contracts";

@Injectable()
export class DispatchQueryService {
  constructor(private readonly mongo: MongoService) {}

  async byOrder(tenantId: string, orderId: string): Promise<DispatchView | null> {
    const doc = await this.mongo.db.collection(READ_COLLECTIONS.DISPATCHES).findOne({ _id: `${tenantId}:${orderId}` as never });
    return (doc as unknown as DispatchView) ?? null;
  }

  /** The driver's current offer (OFFERED & offered to them) or active job (assigned & not terminal). */
  async forDriver(tenantId: string, driverId: string): Promise<DispatchView | null> {
    const doc = await this.mongo.db.collection(READ_COLLECTIONS.DISPATCHES).findOne({
      tenantId,
      $or: [
        { status: "OFFERED", offeredDriverId: driverId },
        { status: { $in: ["DISPATCHED", "PICKED_UP"] }, driverId },
      ],
    });
    return (doc as unknown as DispatchView) ?? null;
  }
}
```

- [ ] **Step 3: Dispatch controller.** Create `apps/read-api/src/dispatch/dispatch.controller.ts`:
```ts
import { Controller, Get, Param, Query } from "@nestjs/common";
import { Roles } from "@flashbite/tenant-context";
import { ROLES, type DispatchView } from "@flashbite/contracts";
import { currentTenant } from "../tenant-scope";
import { DispatchQueryService } from "./dispatch-query.service";

@Controller()
export class DispatchController {
  constructor(private readonly dispatch: DispatchQueryService) {}

  @Get("orders/:orderId/dispatch")
  async byOrder(@Param("orderId") orderId: string): Promise<DispatchView | { status: null }> {
    return (await this.dispatch.byOrder(currentTenant(), orderId)) ?? { status: null };
  }

  @Get("driver/dispatch")
  @Roles(ROLES.DRIVER)
  async forDriver(@Query("driverId") driverId: string): Promise<DispatchView | { status: null }> {
    return (await this.dispatch.forDriver(currentTenant(), driverId)) ?? { status: null };
  }
}
```

- [ ] **Step 4: Module + wiring.** Create `apps/read-api/src/dispatch/dispatch.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { MongoService } from "@flashbite/shared";
import { DispatchController } from "./dispatch.controller";
import { DispatchQueryService } from "./dispatch-query.service";

@Module({ controllers: [DispatchController], providers: [DispatchQueryService, MongoService] })
export class DispatchModule {}
```
Add `DispatchModule` to `imports` in `apps/read-api/src/app.module.ts`.

- [ ] **Step 5: e2e.** Create `apps/read-api/test/dispatch.e2e-spec.ts` mirroring `order-payment.e2e-spec.ts`: override `TokenVerifier` with `createTestAuth`; mint a driver token; seed a `dispatches` doc in Mongo (`_id: berlin:<orderId>`, status DISPATCHED, driverId); assert `GET /orders/:id/dispatch` returns it for the same tenant and `{status:null}` for a tokyo token; assert online toggle `POST /drivers/:id/online` → 202 and `SISMEMBER` true (via a `RedisService`), `/offline` → false; assert `GET /driver/dispatch?driverId=…` returns the active job. Clean up Mongo + Redis after.

- [ ] **Step 6: Run** `pnpm jest apps/read-api/test/dispatch.e2e-spec.ts -- --silent` (infra up) → PASS.

- [ ] **Step 7: Commit**
```bash
git add apps/read-api/src/drivers/drivers.controller.ts apps/read-api/src/dispatch apps/read-api/src/app.module.ts apps/read-api/test/dispatch.e2e-spec.ts
git commit -m "feat(read-api): driver online toggle + dispatch read endpoints (3d-i)"
```

---

## Task 7: write-api — driver dispatch command endpoints

**Files:** Create `apps/write-api/src/orders/dispatch.controller.ts`; modify `apps/write-api/src/orders/orders.module.ts`; create `apps/write-api/test/dispatch.e2e-spec.ts`.

- [ ] **Step 1: Controller.** Create `apps/write-api/src/orders/dispatch.controller.ts`:
```ts
import { Body, Controller, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { getTenantId, Roles } from "@flashbite/tenant-context";
import { DISPATCH_SAGA, ROLES } from "@flashbite/contracts";
import { TemporalService } from "../temporal/temporal.service";

const SIGNALS = {
  accept: DISPATCH_SAGA.ACCEPT_SIGNAL,
  reject: DISPATCH_SAGA.REJECT_SIGNAL,
  pickup: DISPATCH_SAGA.PICKUP_SIGNAL,
  deliver: DISPATCH_SAGA.DELIVER_SIGNAL,
} as const;

@Controller("dispatch")
export class DispatchController {
  constructor(private readonly temporal: TemporalService) {}

  @Post(":orderId/:action")
  @HttpCode(202)
  @Roles(ROLES.DRIVER)
  async signal(
    @Param("orderId") orderId: string,
    @Param("action") action: keyof typeof SIGNALS,
    @Body() body: { driverId: string },
  ): Promise<{ orderId: string; action: string }> {
    const signal = SIGNALS[action];
    if (!signal) throw new NotFoundException(`unknown dispatch action ${action}`);
    const tenantId = getTenantId();
    const handle = this.temporal.client.workflow.getHandle(`dispatch:${tenantId}:${orderId}`);
    try {
      await handle.signal(signal, body.driverId);
    } catch (err) {
      if (/not found|NotFound/i.test(String(err))) throw new NotFoundException(`No active dispatch for ${orderId}`);
      throw err;
    }
    return { orderId, action };
  }
}
```

- [ ] **Step 2: Register** `DispatchController` in `apps/write-api/src/orders/orders.module.ts` controllers (keep existing).

- [ ] **Step 3: e2e.** Create `apps/write-api/test/dispatch.e2e-spec.ts` mirroring `accept.e2e-spec.ts`: boot the real saga worker + write-api; mint a driver token; seed an online driver (Redis) + append an `OrderPlaced`/start a `driverDispatchWorkflow` for the order; assert `POST /dispatch/:id/accept` (driver token, body `{driverId}`) → 202, then `pickup`, `deliver` → 202; assert a non-driver token → 403; assert a non-existent order → 404. (Reuse the offer-then-accept timing from Task 5; poll/await the offer before accepting.)

- [ ] **Step 4: Run** `pnpm jest apps/write-api/test/dispatch.e2e-spec.ts -- --silent` (infra up) → PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/write-api/src/orders/dispatch.controller.ts apps/write-api/src/orders/orders.module.ts apps/write-api/test/dispatch.e2e-spec.ts
git commit -m "feat(write-api): driver dispatch command endpoints (3d-i)"
```

---

## Task 8: projection-worker — dispatch read model

**Files:** Create `apps/projection-worker/src/dispatch-projection.ts`, `apps/projection-worker/test/dispatch-projection.spec.ts`; modify `apps/projection-worker/src/main.ts`, `apps/projection-worker/src/rebuild.ts`.

- [ ] **Step 1: Implement `applyDispatchEvent`.** Create `apps/projection-worker/src/dispatch-projection.ts`, mirroring `projection.ts` (inbox dedup keyed by a distinct consumer name `CONSUMER_GROUPS.DISPATCH_PROJECTION`, version-guarded upsert into `READ_COLLECTIONS.DISPATCHES`, `_id = ${tenantId}:${orderId}`):
```ts
import type { Db } from "mongodb";
import {
  CONSUMER_GROUPS, EVENT_TYPES, READ_COLLECTIONS, DISPATCH_STATUS,
  type EventEnvelope, type DriverOfferedPayload, type DispatchAcceptedPayload, type DispatchFailedPayload,
} from "@flashbite/contracts";

const CONSUMER_NAME = CONSUMER_GROUPS.DISPATCH_PROJECTION;

export async function applyDispatchEvent(db: Db, envelope: EventEnvelope): Promise<"applied" | "skipped"> {
  const inbox = db.collection(READ_COLLECTIONS.PROCESSED);
  const inboxId = `${envelope.tenantId}:${CONSUMER_NAME}:${envelope.eventId}`;
  if (await inbox.findOne({ _id: inboxId as never })) return "skipped";

  const col = db.collection(READ_COLLECTIONS.DISPATCHES);
  const orderId = (envelope.payload as { orderId: string }).orderId;
  const _id = `${envelope.tenantId}:${orderId}`;
  const base = { tenantId: envelope.tenantId, orderId, version: envelope.version, updatedAt: envelope.occurredAt };

  const set: Record<string, unknown> | null = (() => {
    switch (envelope.eventType) {
      case EVENT_TYPES.DRIVER_OFFERED:
        return { ...base, status: DISPATCH_STATUS.OFFERED, offeredDriverId: (envelope.payload as DriverOfferedPayload).driverId };
      case EVENT_TYPES.DISPATCH_ACCEPTED:
        return { ...base, status: DISPATCH_STATUS.DISPATCHED, driverId: (envelope.payload as DispatchAcceptedPayload).driverId };
      case EVENT_TYPES.ORDER_PICKED_UP:
        return { ...base, status: DISPATCH_STATUS.PICKED_UP };
      case EVENT_TYPES.ORDER_DELIVERED:
        return { ...base, status: DISPATCH_STATUS.DELIVERED };
      case EVENT_TYPES.DISPATCH_FAILED:
        return { ...base, status: DISPATCH_STATUS.FAILED, reason: (envelope.payload as DispatchFailedPayload).reason };
      default:
        return null;
    }
  })();

  if (set) {
    const existing = await col.findOne({ _id: _id as never });
    if (!existing || (existing.version as number) < envelope.version) {
      await col.updateOne({ _id: _id as never }, { $set: set }, { upsert: true });
    }
  }

  try {
    await inbox.insertOne({ _id: inboxId as never, tenantId: envelope.tenantId, consumer: CONSUMER_NAME, eventId: envelope.eventId, processedAt: new Date() });
  } catch (err) { if ((err as { code?: number }).code !== 11000) throw err; }
  return "applied";
}
```

- [ ] **Step 2: Wire a second consumer.** In `apps/projection-worker/src/main.ts`, add a `runDispatchConsumer` (mirror `runConsumer`) subscribing to `TOPICS.DISPATCH_EVENTS` and calling `applyDispatchEvent`; in `main()` create a second kafka consumer on `CONSUMER_GROUPS.DISPATCH_PROJECTION`, start it, and stop it in shutdown.

- [ ] **Step 3: Extend rebuild.** In `apps/projection-worker/src/rebuild.ts`, add a pass that replays `dispatch-events` (or the `DISPATCH` aggregate events) into the `dispatches` collection via `applyDispatchEvent` (follow the existing rebuild's structure).

- [ ] **Step 4: Unit test.** Create `apps/projection-worker/test/dispatch-projection.spec.ts`: an in-memory/`mongodb-memory-server`-free test that mirrors any existing projection unit test (if projection has only e2e, write a small live-Mongo test using `connectMongo` like the others), folding a `DriverOffered → DispatchAccepted → OrderPickedUp → OrderDelivered` sequence into one `dispatches` doc and asserting the final `{status: DELIVERED, driverId}` + idempotent re-apply (`skipped`). Clean up after.

- [ ] **Step 5: Run** `pnpm jest apps/projection-worker -- --silent` (infra up) → PASS.

- [ ] **Step 6: Commit**
```bash
git add apps/projection-worker/src/dispatch-projection.ts apps/projection-worker/src/main.ts apps/projection-worker/src/rebuild.ts apps/projection-worker/test/dispatch-projection.spec.ts
git commit -m "feat(projection): dispatch read model (3d-i)"
```

---

## Task 9: Config, schema registration, docs + full verification

**Files:** Modify `packages/shared/src/config.ts`, `.env.example`, `docs/ARCHITECTURE.md`, `apps/write-api/requests.http`.

- [ ] **Step 1: Config.** In `packages/shared/src/config.ts` add to `AppConfig` + `loadConfig`:
```ts
  dispatchOfferTimeoutSeconds: number;
  dispatchMaxOffers: number;
```
```ts
    dispatchOfferTimeoutSeconds: Number(env.DISPATCH_OFFER_TIMEOUT_SECONDS ?? 30),
    dispatchMaxOffers: Number(env.DISPATCH_MAX_OFFERS ?? 5),
```

- [ ] **Step 2: `.env.example`** — add (note: this file may be permission-blocked; if the Edit/Write tool is denied, leave it and report so the human adds it — the config defaults cover runtime):
```
# Phase 3d driver dispatch
DISPATCH_OFFER_TIMEOUT_SECONDS=30
DISPATCH_MAX_OFFERS=5
```

- [ ] **Step 3: Register dispatch schemas.** Run `pnpm register:schemas` (registers the 5 new `dispatch-events` subjects from `SUBJECTS`). Expected: "registered ... DriverOffered/DispatchAccepted/OrderPickedUp/OrderDelivered/DispatchFailed". (Schema registry must be up.)

- [ ] **Step 4: CI / topic creation.** If `infra/docker-compose.ci.yml` or `.github/workflows/test.yml` pre-creates topics, add `dispatch-events`. If topics are auto-created by the broker (Redpanda default), just confirm `register:schemas` runs in CI before the dispatch suites (it already runs for 3b).

- [ ] **Step 5: Docs.** In `docs/ARCHITECTURE.md` §3, add a "Phase 3d-i — driver dispatch" subsection: the multi-aggregate handoff (`OrderAccepted` → `driverDispatchWorkflow`), the re-offer loop, the `DriverDispatch` aggregate / `dispatch-events` topic / `dispatches` read model, availability (online ∩ geo ∩ not-busy, city-center reference), and the flagged simplifications. Add `dispatch-worker`-equivalent note that it runs inside `saga-worker`.

- [ ] **Step 6: requests.http.** In `apps/write-api/requests.http` add driver online + dispatch action requests:
```http
### Phase 3d — driver goes online (driver token)
POST {{readUrl}}/drivers/{{driverId}}/online
Authorization: Bearer {{loginDriver.response.body.$.accessToken}}

### Driver accepts / picks up / delivers a dispatch
POST {{baseUrl}}/dispatch/{{orderId}}/accept
Authorization: Bearer {{loginDriver.response.body.$.accessToken}}
Content-Type: application/json

{ "driverId": "{{driverId}}" }
```
(Add a `# @name loginDriver` login block if one doesn't already exist, mirroring `loginCustomer`.)

- [ ] **Step 7: Full verification.** Infra up, schemas registered, only fresh workers running:
```bash
pnpm jest packages/contracts packages/shared apps/saga-worker apps/read-api apps/write-api apps/projection-worker -- --silent
```
Expected: PASS — contracts, shared (incl. dispatch-aggregate), saga (incl. dispatch-workflow unit + dispatch e2e), read-api (incl. dispatch e2e), write-api (incl. dispatch e2e), projection (incl. dispatch). Existing order/payment/telemetry suites unaffected.

- [ ] **Step 8: Commit**
```bash
git add packages/shared/src/config.ts docs/ARCHITECTURE.md apps/write-api/requests.http
git commit -m "docs+config: dispatch timeouts, schemas, architecture (3d-i)"
```

---

## Manual smoke (after merge)

Full plane (`infra:up`, `register:schemas`, all order-plane workers incl. `saga-worker`, `dev:read-api`, `dev:write-api`):
1. Driver goes online (`POST /drivers/:id/online`) and emits GPS near the city center.
2. Place → confirm → merchant accept an order → `driverDispatchWorkflow` starts, offers the job (a `dispatches` doc appears, status OFFERED, offeredDriverId = the driver).
3. `POST /dispatch/:id/accept` → DISPATCHED; `/pickup` → PICKED_UP; `/deliver` → DELIVERED; the driver leaves the busy set.
4. With no online driver, the dispatch ends `FAILED(NO_DRIVERS_AVAILABLE)` after `DISPATCH_MAX_OFFERS`.

---

## Self-review checklist (controller runs before dispatch)

- **Spec coverage:** aggregate (T2) · events/topic/subjects/status/keys (T1) · workflow re-offer loop (T3) · selection+busy+append activities + OrderAccepted starter (T4) · live dispatch e2e (T5) · online toggle + dispatch reads (T6) · driver command endpoints (T7) · read model + rebuild (T8) · config/schemas/docs/verify (T9). ✓
- **Type consistency:** `DispatchArgs {tenantId, orderId, offerTimeoutSeconds, maxOffers}` matches the starter args (T4) and the workflow (T3) and both unit + e2e args (T3/T5). `DispatchActivities` type from `dispatch-activities.ts` (T4) is what `dispatch-workflow.ts` (T3) `proxyActivities` against — names must match exactly (`selectNearestAvailableDriverActivity`, `markBusyActivity`, `clearBusyActivity`, `record*Activity`). `dispatchAggregateId`/`driver*Key` (T1) used in T4/T5/T6. `topic` param on `appendWithExpectedVersion` (T2) used by T4. ✓
- **No placeholders:** novel code is complete; mirror-tasks (T6 e2e, T7 e2e, T8 unit, T9 docs) reference an exact existing template to copy. ✓
- **Verified:** `ROLES.DRIVER === "driver"` exists; `GeoPoint`/`CITY_CENTERS` are `{lng, lat}` (matches the T4 activity usage). Dispatch payloads are strings only (no Avro double/int concerns).
- **Watch:** `packages/shared/src/index.ts` must not double-export `InvalidTransitionError` from both order- and dispatch-aggregate (see T2 Step 5) — pick one re-export site.
