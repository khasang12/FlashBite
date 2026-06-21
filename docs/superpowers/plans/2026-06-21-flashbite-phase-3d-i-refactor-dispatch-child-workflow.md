# Dispatch-as-child-workflow Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Kafka `dispatch-starter` choreography with orchestration — the order-lifecycle workflow starts the `driverDispatchWorkflow` as a Temporal **child** and awaits it, returning the end-to-end fulfillment outcome.

**Architecture:** `orderLifecycleWorkflow` → after `recordOrderAccepted`, `executeChild(driverDispatchWorkflow, { workflowId: dispatch:<t>:<o> })`. The dispatch bounded context (aggregate / `dispatch-events` topic / `dispatches` read model) and the driver command/read endpoints are unchanged — only the start mechanism and the order-workflow result contract change.

**Tech Stack:** Temporal (`@temporalio/workflow` `executeChild`, `TestWorkflowEnvironment`), saga-worker, `@flashbite/contracts`, Jest.

**PREREQUISITE:** Build on `main` **after PR #25 (3d-i dispatch) and PR #26 (payment retry-cap) are both merged.** This refactor edits files those PRs introduce/modify (`dispatch-workflow.ts`, `dispatch-activities.ts`, `main.ts` dispatch starter, `workflows.ts` retry-cap). Create the branch off the merged `main`.

---

## File Structure

**Modified:**
- `packages/contracts/src/index.ts` — `ORDER_SAGA_RESULTS.{DELIVERED,DISPATCH_FAILED}`; drop `CONSUMER_GROUPS.DISPATCH_STARTER` (+ `contracts.spec.ts`).
- `apps/saga-worker/src/workflows.ts` — order workflow `executeChild`s dispatch; `OrderLifecycleArgs` gains dispatch knobs.
- `apps/saga-worker/src/main.ts` — delete `startDispatchConsumer` + its consumer/shutdown; pass dispatch knobs into the order-workflow args.
- `apps/saga-worker/src/dispatch-workflow.ts` — ensure dispatch activities `proxyActivities` has `retry: { maximumAttempts: 5 }` (parity with #26).
- `apps/saga-worker/test/workflow.spec.ts` — accept path now drives the real child via stubbed dispatch activities; result assertions updated.
- `apps/saga-worker/test/saga.e2e-spec.ts`, `apps/saga-worker/test/accept.e2e-spec.ts` — accept flow seeds an online driver + drives the child to `DELIVERED`; result assertions updated.
- `apps/saga-worker/test/consumer.spec.ts` — remove any dispatch-starter coverage (order starter unchanged).
- `docs/ARCHITECTURE.md` — choreography → orchestration description.

**Deleted behavior:** the `dispatch-starter` Kafka consumer (no file deletion; it's inline in `main.ts`).

---

## Task 1: Contracts — order-workflow result states + drop starter group

**Files:** `packages/contracts/src/index.ts`, `packages/contracts/src/contracts.spec.ts`

- [ ] **Step 1:** In `ORDER_SAGA_RESULTS` add:
```ts
  DELIVERED: "DELIVERED",
  DISPATCH_FAILED: "DISPATCH_FAILED",
```
- [ ] **Step 2:** Remove `DISPATCH_STARTER: "dispatch-starter"` from `CONSUMER_GROUPS` (keep `DISPATCH_PROJECTION`). Grep the repo for `DISPATCH_STARTER` first; the only user is `main.ts` (removed in Task 3) — if anything else references it, fix there.
- [ ] **Step 3:** Update `contracts.spec.ts` `ORDER_SAGA_RESULTS`/`CONSUMER_GROUPS` assertions (`toEqual` exact-match objects must include/exclude the changed keys).
- [ ] **Step 4:** `pnpm jest packages/contracts -- --silent` → PASS.
- [ ] **Step 5:** Commit `feat(contracts): order-workflow DELIVERED/DISPATCH_FAILED; drop dispatch-starter group`.

---

## Task 2: Order workflow executes the dispatch child

**Files:** `apps/saga-worker/src/workflows.ts`

- [ ] **Step 1:** Add imports: `executeChild` from `@temporalio/workflow`; `DISPATCH_STATUS` from `@flashbite/contracts`; `driverDispatchWorkflow` (value import) from `./dispatch-workflow`.
- [ ] **Step 2:** Extend `OrderLifecycleArgs` with the dispatch knobs (passed through to the child):
```ts
  offerTimeoutSeconds: number;
  maxOffers: number;
  deliverySeconds: number;
```
- [ ] **Step 3:** In the accept branch, after `recordOrderAcceptedActivity`, run the child and return its outcome. Replace:
```ts
    await recordOrderAcceptedActivity(args.tenantId, args.orderId);
    return ORDER_SAGA_RESULTS.ACCEPTED;
```
with:
```ts
    await recordOrderAcceptedActivity(args.tenantId, args.orderId);
    // Orchestrate the fulfillment leg as a child workflow (one tree per order).
    const dispatchOutcome = await executeChild(driverDispatchWorkflow, {
      workflowId: `dispatch:${args.tenantId}:${args.orderId}`,
      args: [{
        tenantId: args.tenantId, orderId: args.orderId,
        offerTimeoutSeconds: args.offerTimeoutSeconds, maxOffers: args.maxOffers, deliverySeconds: args.deliverySeconds,
      }],
    });
    return dispatchOutcome === DISPATCH_STATUS.DELIVERED
      ? ORDER_SAGA_RESULTS.DELIVERED
      : ORDER_SAGA_RESULTS.DISPATCH_FAILED;
```
(Keep the #26 try/catch around `capturePaymentActivity` intact — the `executeChild` runs only after a successful capture + accept.)
- [ ] **Step 4:** Confirm `workflows.ts` still `export { driverDispatchWorkflow } from "./dispatch-workflow"` (so the child is in the bundle) — it already does from 3d-i; the value import in Step 1 is additionally needed for `executeChild`'s type.
- [ ] **Step 5:** Commit `feat(saga): order workflow executes dispatch as a child (orchestration)`.

---

## Task 3: Remove the dispatch-starter consumer; thread knobs into order args

**Files:** `apps/saga-worker/src/main.ts`

- [ ] **Step 1:** Delete the `startDispatchConsumer` function and, in `main()`, its consumer creation (`CONSUMER_GROUPS.DISPATCH_STARTER`), `start`, and `shutdown` lines. Remove now-unused imports (`DISPATCH_SAGA` if only used there, `OrderAcceptedPayload` if only used there — check).
- [ ] **Step 2:** In the **order** starter (`startOrderConsumer`'s `workflow.start` args), add the dispatch knobs so the order workflow can pass them to the child:
```ts
      args: [{ tenantId: envelope.tenantId, orderId: p.orderId, totalAmount: p.totalAmount, slaSeconds, confirmSeconds, offerTimeoutSeconds, maxOffers, deliverySeconds }],
```
Thread `offerTimeoutSeconds`/`maxOffers`/`deliverySeconds` into `startOrderConsumer` (new params) and pass `config.dispatchOfferTimeoutSeconds`, `config.dispatchMaxOffers`, `config.dispatchDeliveryTimeoutSeconds` at the `main()` call site. The worker still registers both workflow types + both activity sets + the Redis client (the child runs on the same task queue, same worker).
- [ ] **Step 2b:** Confirm the dispatch activities are still merged into the worker's `activities` map (they are — needed for the child).
- [ ] **Step 3:** Commit `refactor(saga): remove dispatch-starter consumer; order workflow owns dispatch start`.

---

## Task 4: Dispatch activity retry parity

**Files:** `apps/saga-worker/src/dispatch-workflow.ts`

- [ ] **Step 1:** Give the dispatch `proxyActivities` the same retry cap as the payment activities:
```ts
  proxyActivities<DispatchActivities>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 5 } });
```
- [ ] **Step 2:** (Optional, parity) the read-api/write-api dispatch HTTP isn't activity-side; no change. Selection/append activities now bounded.
- [ ] **Step 3:** `pnpm jest apps/saga-worker/test/dispatch-workflow.spec.ts -- --silent` → still PASS (retry cap doesn't change happy/timeout assertions).
- [ ] **Step 4:** Commit `fix(saga): retry-cap on dispatch activities (parity)`.

---

## Task 5: Order workflow unit tests under the new contract

**Files:** `apps/saga-worker/test/workflow.spec.ts`

The accept path now runs the real `driverDispatchWorkflow` child (the test worker already bundles it via `workflowsPath`). Stub the **dispatch activities** alongside the order activities so the child runs deterministically.

- [ ] **Step 1:** Extend `stubActivities` with the dispatch activities (return a one-driver happy path): `selectNearestAvailableDriverActivity` returns `"d1"` once then `null`; `markBusyActivity`/`clearBusyActivity`/`recordDriverOfferedActivity`/`recordDispatchAcceptedActivity`/`recordOrderPickedUpActivity`/`recordOrderDeliveredActivity`/`recordDispatchFailedActivity` push to `calls`. Add the dispatch knobs to `baseArgs` (`offerTimeoutSeconds: 300, maxOffers: 5, deliverySeconds: 300`).
- [ ] **Step 2:** Update the **ACCEPTED** test → now expects `DELIVERED`: after confirming + approving, also signal the child (`dispatchAccept`/`dispatchPickup`/`dispatchDeliver` to `dispatch:berlin:<id>`), and assert the parent returns `"DELIVERED"`. (Get the child handle via `env.client.workflow.getHandle("dispatch:berlin:<id>")` after a brief wait, or signal-by-id.)
- [ ] **Step 3:** Add an accept-then-no-driver test → child `DispatchFailed` → parent returns `"DISPATCH_FAILED"` (selection returns `null`).
- [ ] **Step 4:** The cancel/decline/sla/payment-timeout/payment-failed cases are unchanged (no dispatch) — leave as-is.
- [ ] **Step 5:** `pnpm jest apps/saga-worker/test/workflow.spec.ts -- --silent` → PASS.
- [ ] **Step 6:** Commit `test(saga): order workflow returns DELIVERED/DISPATCH_FAILED via child`.

---

## Task 6: e2e + docs + full verification

**Files:** `apps/saga-worker/test/saga.e2e-spec.ts`, `apps/saga-worker/test/accept.e2e-spec.ts`, `docs/ARCHITECTURE.md`

- [ ] **Step 1:** `saga.e2e` / `accept.e2e` accept-path: seed an online+geo driver (Redis `sadd` online + `geoadd` geo at `CITY_CENTERS.berlin`); after the order is accepted (merchant signal), the child auto-starts — signal `dispatch:<t>:<o>` accept→pickup→deliver and assert the parent result is `DELIVERED`. Update args to include the dispatch knobs. Clean up Redis + event_store (incl. `dispatch:<id>`).
- [ ] **Step 2:** `docs/ARCHITECTURE.md` §3: replace the "OrderAccepted → dispatch-starter consumer → workflow" text with "the order workflow `executeChild`s the dispatch child"; keep the bounded-context note; update the §3 decisions bullet for 3d-i.
- [ ] **Step 3:** Full sweep (infra up, schemas registered, no stale workers):
```bash
pnpm jest packages/contracts packages/shared apps/saga-worker apps/write-api apps/read-api apps/projection-worker -- --silent
```
Expected: PASS — incl. updated order saga unit + e2e; write-api/read-api dispatch suites unchanged (signals to the child id still resolve); projection unchanged.
- [ ] **Step 4:** Commit `docs+test: dispatch-child orchestration e2e + architecture`.

---

## Manual smoke (after merge)
Full plane running: place → confirm → merchant accept (driver online+located first) → in the Temporal UI, one `<t>:<o>` parent shows a `dispatch:<t>:<o>` **child**; driver accept/pickup/deliver drives the child; the parent completes `DELIVERED`. No `dispatch-starter` consumer group exists.

## Self-review checklist (controller runs before dispatch)
- **Spec coverage:** result states (T1) · executeChild (T2) · remove starter (T3) · dispatch retry parity (T4) · unit under new contract (T5) · e2e + docs (T6). ✓
- **Type consistency:** `OrderLifecycleArgs` dispatch knobs (T2) match the child `DispatchArgs` field names (`offerTimeoutSeconds`/`maxOffers`/`deliverySeconds`) and the starter args (T3). `executeChild(driverDispatchWorkflow, …)` returns the dispatch result string compared to `DISPATCH_STATUS.DELIVERED`. ✓
- **Watch:** signalling a child by its `workflowId` from write-api works unchanged — verify in T6 e2e. The child must run on the same task queue (default for `executeChild`) so the existing worker handles it.
