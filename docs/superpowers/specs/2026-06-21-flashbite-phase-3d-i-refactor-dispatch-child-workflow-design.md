# Phase 3d-i refactor — Dispatch as a child of the order workflow (design)

**Status:** approved (brainstorm) — ready for implementation plan
**Date:** 2026-06-21
**Builds on / depends on:** PR #25 (3d-i dispatch backend) **and** PR #26 (saga payment retry-cap) — both must be merged to `main` first; this refactor builds on that combined base.

## Goal

Replace the **event-choreography** handoff (order workflow completes → `OrderAccepted` on Kafka → a
`dispatch-starter` consumer starts a *separate* `driverDispatchWorkflow`) with **orchestration**: the
order-lifecycle workflow starts the dispatch workflow as a **Temporal child workflow and awaits it**, so
one workflow per order spans the entire journey (place → confirm → pay → accept → dispatch → delivered).
Managing/observing an order's complete flow becomes one workflow tree instead of two correlated IDs.

## Decisions (locked during brainstorm)

1. **Child workflow, parent awaits (flavor a).** After recording `OrderAccepted`, the order workflow
   `executeChild(driverDispatchWorkflow, …)` and returns the fulfillment outcome.
2. **Bounded contexts stay separate at the data layer.** `DriverDispatch` keeps its own aggregate
   (`dispatch:<orderId>`), `dispatch-events` topic, Avro subjects, and `dispatches` read model. Only the
   **start mechanism** changes (Kafka consumer → child-workflow start). This is a deliberate trade:
   orchestration over choreography for the fulfillment leg, chosen for single-operator manageability.
3. **Remove the `dispatch-starter` Kafka consumer** (+ its `CONSUMER_GROUPS.DISPATCH_STARTER` usage). The
   order workflow is the only thing that starts a dispatch.
4. **Dispatch activities get the same retry-cap** as the payment fix (`maximumAttempts`), so dispatch
   can't hang either.

## Behavior change: order workflow result contract

Today `orderLifecycleWorkflow` returns at acceptance (`ACCEPTED`). After this refactor it returns the
**end-to-end** outcome:
```
... confirm → authorize → merchant race →
  accept  → capture → recordOrderAccepted → executeChild(driverDispatchWorkflow) → return its result
            (DELIVERED | FAILED-as-CANCELLED_DISPATCH_FAILED... see below)
  decline / sla / payment-timeout / payment-failed → unchanged terminal results (no dispatch)
```
- The child's result (`DELIVERED` / `FAILED`) becomes (part of) the parent's return. Add
  `ORDER_SAGA_RESULTS.DELIVERED` and `ORDER_SAGA_RESULTS.DISPATCH_FAILED` (or return the child result
  verbatim). The **order aggregate is unchanged** — it's still `ACCEPTED` at the event level; dispatch
  outcome lives in the dispatch aggregate/read model. The parent's *return value* is just the workflow's
  terminal status for observability.
- **Important ripple:** every test/asserter that expects the order workflow to return `"ACCEPTED"` must
  change (it now continues into dispatch). The accept-path e2e now also needs a **dispatchable driver**
  seeded (online + geo), or the child ends `FAILED` and the parent returns the dispatch-failed result.

## Changes

### contracts (`@flashbite/contracts`)
- `ORDER_SAGA_RESULTS`: add `DELIVERED` and `DISPATCH_FAILED` (the order workflow's new terminal states).
- Remove `CONSUMER_GROUPS.DISPATCH_STARTER` (no longer used) — or leave it deprecated; prefer removing.
- (`DISPATCH_SAGA`, dispatch events/status/keys unchanged.)

### saga-worker
- `workflows.ts` (`orderLifecycleWorkflow`): after `recordOrderAcceptedActivity`, start the dispatch
  child and await it:
  ```ts
  import { executeChild } from "@temporalio/workflow";
  import { driverDispatchWorkflow } from "./dispatch-workflow";
  ...
  await recordOrderAcceptedActivity(args.tenantId, args.orderId);
  const dispatchResult = await executeChild(driverDispatchWorkflow, {
    workflowId: `dispatch:${args.tenantId}:${args.orderId}`,
    args: [{ tenantId: args.tenantId, orderId: args.orderId, offerTimeoutSeconds: args.offerSeconds, maxOffers: args.maxOffers, deliverySeconds: args.deliverySeconds }],
    // default parent-close policy TERMINATE is fine since the parent awaits; same task queue.
  });
  return dispatchResult === DISPATCH_STATUS.DELIVERED ? ORDER_SAGA_RESULTS.DELIVERED : ORDER_SAGA_RESULTS.DISPATCH_FAILED;
  ```
  `OrderLifecycleArgs` gains `offerSeconds`, `maxOffers`, `deliverySeconds` (passed through to the child),
  sourced from config by the starter. The dispatch workflow file is imported as a value here (so it's in
  the same bundle — already re-exported via `workflows.ts`).
- `dispatch-workflow.ts`: unchanged logic; ensure dispatch activities' `proxyActivities` carries
  `retry: { maximumAttempts: 5 }` (parity with the payment fix).
- `main.ts`: **delete `startDispatchConsumer`** + its Kafka consumer + shutdown wiring. The order
  starter now passes the dispatch knobs into `orderLifecycleWorkflow` args (`config.dispatchOfferTimeoutSeconds`,
  `config.dispatchMaxOffers`, `config.dispatchDeliveryTimeoutSeconds`). The worker still registers both
  workflow types + both activity sets (the child runs on the same task queue).

### write-api / read-api (unchanged surface)
- Driver commands still `getHandle("dispatch:<t>:<o>").signal(...)` — the child's `workflowId` is exactly
  that, so signals/queries keep working. **No change** to `dispatch.controller.ts`, online toggle, or the
  dispatch read endpoints. (Confirm: signalling a child by its workflowId works the same as a top-level
  workflow — it does.)

### tests (the bulk of the work)
- **order saga unit** (`workflow.spec.ts`): the accept path now stubs an `executeChild` outcome. Child
  workflows can't be trivially stubbed via the activity stub map — instead register BOTH workflows in the
  test worker (workflowsPath already bundles them) and stub the *dispatch activities* so the real child
  runs deterministically (select→offer→accept→deliver), or use a mocked child. Assert the parent returns
  `DELIVERED`/`DISPATCH_FAILED`. The cancel/decline/sla/timeout cases are unchanged.
- **order saga e2e** (`saga.e2e`, `accept.e2e`): the accept flow must seed an online+geo driver and
  drive the dispatch child (signal accept/pickup/deliver to `dispatch:<t>:<o>`) to reach `DELIVERED`;
  update result assertions. `payment-failed`/`breach` unchanged.
- **dispatch e2e**: the standalone dispatch e2e still valid (it starts `driverDispatchWorkflow` directly
  by id — which is also how the child is addressed). Keep it; optionally add a parent-drives-child e2e.
- Remove the dispatch-starter consumer test path; `consumer.spec` (order starter) unchanged.

### docs
- `docs/ARCHITECTURE.md` §3: replace the "OrderAccepted → dispatch-starter consumer → workflow" choreography
  description with "order workflow `executeChild`s the dispatch child"; note the deliberate
  orchestration-over-choreography decision + that the dispatch bounded context (aggregate/topic/read model)
  is unchanged.

## Trade-offs (documented)
- **Gain:** one workflow per order end-to-end; Temporal UI shows a parent→child tree; no Kafka handoff to
  maintain; single ID to reason about.
- **Lose:** the pure event-on-the-bus choreography between order and dispatch (a microservices pattern the
  current design demonstrates). Dispatch is now coupled to the order workflow at the *orchestration* layer
  (still decoupled at the data/event layer). A future "dispatch owned by a separate team/deployable" would
  argue for reverting to choreography — noted as backlog.
- **Longer-running order workflow** (stays Running until delivery) — fine for Temporal.

## Testing
All saga unit + e2e green with the new result contract; write-api/read-api dispatch suites unchanged and
still green (signals to the child id); projection unchanged. Full sweep of contracts/shared/saga/write-api/
read-api/projection.

## Scope boundary / backlog
- No change to aggregates, events, topics, read models, or the driver/customer UIs.
- Revert-to-choreography (separate deployable) if dispatch ever needs independent ownership/scaling.
- `DISPATCH_FAILED` order-workflow result still leaves the order `ACCEPTED` (requeue/refund remains backlog).

## Success criteria
1. Placing→confirming→accepting an order runs the dispatch as a **child** of the order workflow; the
   Temporal UI shows one parent (`<t>:<o>`) with a child (`dispatch:<t>:<o>`).
2. The `dispatch-starter` Kafka consumer is gone; nothing starts a dispatch except the order workflow.
3. Driver command endpoints + dispatch read endpoints work unchanged (signals to the child id).
4. The order workflow returns the end-to-end outcome (`DELIVERED`/`DISPATCH_FAILED`/the existing cancel
   results); the `Order` and `DriverDispatch` aggregates/events/read-models are unchanged.
5. All suites green under the new result contract.
