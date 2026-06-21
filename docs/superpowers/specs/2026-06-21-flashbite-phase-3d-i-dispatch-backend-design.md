# Phase 3d-i — Driver dispatch backend (design)

**Status:** approved (brainstorm) — ready for implementation plan
**Date:** 2026-06-21
**Builds on:** Phase 3a (event-sourced `Order` aggregate), 3b (Avro bus), 3c/3c-ii/3c-iii (payments + dispatch-adjacent UI), and the existing telemetry plane (driver GPS → Redis geo, nearby-drivers query). Slice **3d-i** of Phase 3d (driver dispatch & delivery). Branch `phase-3d-i-dispatch-backend` off `main`.

## Goal

Connect the order plane to the driver plane: when an order is `ACCEPTED`, dispatch a driver and drive
the delivery to completion. This slice is **backend only** — a new event-sourced `DriverDispatch`
aggregate, a Temporal `driverDispatchWorkflow` with a re-offer loop, driver online/availability, the
driver-action command endpoints, and the dispatch read path. The driver job UI (3d-ii) and customer
live-location tracking (3d-iii) consume this backend later.

## Decisions (locked during brainstorm)

1. **New `DriverDispatch` aggregate** (not extending `Order`) — a second event-sourced bounded context.
2. **Auto-assign nearest, with a re-offer loop** — offer to the single nearest available driver;
   on reject/timeout, re-offer to the next-nearest; exhaust → `DispatchFailed`.
3. **Availability = explicit online toggle ∩ has a geo position ∩ not currently busy.** A driver opts
   in via an online/offline toggle (the online set is the liveness signal); the geo index gives their
   position for "nearest"; a busy set excludes drivers on an active dispatch.
4. **One worker process** — the dispatch workflow lives inside the existing `saga-worker` (its own
   workflow file + activities + a second Kafka consumer), not a new app. Bounded-context separation is
   preserved in code (separate aggregate, events, topic, workflow); ops footprint stays flat.
5. **Each offer is recorded as a `DriverOffered` event** (event-sourced); rejections/timeouts are
   transient workflow state (a `tried` set), not events.

### Simplifications (flagged; backlog)
- **Dispatch reference point = the tenant's `CITY_CENTERS` location** (proxy for the merchant/pickup
  area), because orders carry no geo coordinates today. Per-order pickup/delivery coordinates → backlog.
- **Online is the liveness gate** (no separate "recently-pinged" freshness window; the geo index has no
  TTL today). A driver who never goes online is never offered jobs even if emitting GPS.
- **`driverId` is client-supplied and tenant-scoped** (same as today's telemetry path-param `driverId`),
  not bound to the JWT `sub`. Binding driver identity to the token → backlog.
- **`DispatchFailed` is terminal**; the order stays `ACCEPTED` (payment already captured at accept).
  Auto-requeue / refund-on-undeliverable → backlog.

## The DriverDispatch aggregate

- **aggregateId = `dispatch:<orderId>`** (helper `dispatchAggregateId(orderId)`), distinct from the
  Order's `aggregateId = orderId` — required because `event_store` is unique on
  `(tenantId, aggregateId, version)` and aggregateType is **not** part of that key. One dispatch per order.
- **aggregateType = `DISPATCH`** (`AGGREGATE_TYPES.DISPATCH`).
- **Events** (on the new `dispatch-events` topic): `DriverOffered` (per offer) → `DispatchAccepted` →
  `OrderPickedUp` → `OrderDelivered`; terminal failure `DispatchFailed`.
- **Derived status** (`DISPATCH_STATUS`): `OFFERED` → `DISPATCHED` (accepted) → `PICKED_UP` →
  `DELIVERED`; or `FAILED`.
- **`dispatch-aggregate.ts` (pure, in `@flashbite/shared`)** mirrors `order-aggregate.ts`:
  `DispatchState`, `INITIAL_DISPATCH_STATE`, `foldDispatch(state, event)`, and command functions that
  validate the transition and return the event payload (`offer`, `acceptOffer`, `pickup`, `deliver`,
  `fail`) — throwing `InvalidTransitionError` on illegal transitions (so re-delivered signals / retries
  are safe no-ops, matching the order aggregate's pattern).

## Event flow (the saga handoff + re-offer loop)

```
OrderAccepted (order-events)
  └─ saga-worker's NEW dispatch consumer starts driverDispatchWorkflow
       workflowId = dispatch:<tenant>:<orderId>   (reject-duplicate reuse policy → idempotent)
       tried = {}
       loop up to DISPATCH_MAX_OFFERS:
         candidate = selectNearestAvailableDriverActivity(tenant, exclude=tried)
           └─ none → recordDispatchFailedActivity(NO_DRIVERS_AVAILABLE) → return FAILED
         recordDriverOfferedActivity(candidate)         status OFFERED;  tried.add(candidate)
         await accept|reject signal from `candidate`, up to DISPATCH_OFFER_TIMEOUT_SECONDS
           ├─ accept  → markBusyActivity(candidate)
           │            recordDispatchAcceptedActivity(candidate)   status DISPATCHED
           │            await pickup signal → recordOrderPickedUpActivity   status PICKED_UP
           │            await deliver signal → recordOrderDeliveredActivity status DELIVERED
           │            clearBusyActivity(candidate)  → return DELIVERED
           ├─ reject  → continue loop (next-nearest, immediately)
           └─ timeout → continue loop (silent decline)
       exhausted → recordDispatchFailedActivity(NO_DRIVERS_AVAILABLE) → return FAILED
```

- The accept/reject/pickup/deliver signals each carry the `driverId`; the workflow ignores any signal
  whose `driverId` ≠ the currently-offered/assigned driver (stale/foreign responses don't advance the loop).
- All I/O (Redis selection, busy set, event append) is in **activities**; the workflow stays
  deterministic (imports only `@temporalio/workflow`, `@flashbite/contracts`, and the activities type).
- **Idempotency:** `workflowId = dispatch:<tenant>:<orderId>` with reject-duplicate reuse policy, so a
  re-delivered `OrderAccepted` cannot start a second dispatch. Each event append is at the loaded
  aggregate version (optimistic concurrency); illegal transitions are benign no-ops.

## Availability (Redis, all hash-tagged per tenant → one slot)

- **Geo (existing):** `driverGeoKey(tenant)` = `{tenant:X}:drivers:geo` — driver positions from telemetry.
- **Online set (new):** `driverOnlineKey(tenant)` = `{tenant:X}:drivers:online` — a Redis set of online driverIds.
- **Busy set (new):** `driverBusyKey(tenant)` = `{tenant:X}:drivers:busy` — driverIds on an active dispatch.
- **`selectNearestAvailableDriverActivity(tenant, exclude[])`:** `GEOSEARCH` the geo key around
  `CITY_CENTERS[tenant]` ascending by distance, then return the first member that is in `online`, not in
  `busy`, and not in `exclude`. Returns `null` if none.
- Busy lifecycle: `markBusy` on accept, `clearBusy` on `DELIVERED` and on `DispatchFailed`-after-accept
  (the failure path before any accept never marks busy).

## New code & wiring

### contracts (`@flashbite/contracts`)
- `AGGREGATE_TYPES.DISPATCH = "DISPATCH"`.
- `TOPICS.DISPATCH_EVENTS = "dispatch-events"`.
- `EVENT_TYPES`: `DRIVER_OFFERED`, `DISPATCH_ACCEPTED`, `ORDER_PICKED_UP`, `ORDER_DELIVERED`, `DISPATCH_FAILED`.
- `DISPATCH_STATUS = { OFFERED, DISPATCHED, PICKED_UP, DELIVERED, FAILED }`.
- `DISPATCH_SAGA = { TASK_QUEUE, WORKFLOW_TYPE, ACCEPT_SIGNAL, REJECT_SIGNAL, PICKUP_SIGNAL, DELIVER_SIGNAL }`.
  Reuse the existing `order-lifecycle` task queue (same worker hosts both) — the workflow type is what differs.
- `DISPATCH_FAIL_REASONS = { NO_DRIVERS_AVAILABLE }`.
- Payload types (`DriverOfferedPayload {orderId, driverId}`, `DispatchAcceptedPayload {orderId, driverId}`,
  `OrderPickedUpPayload {orderId}`, `OrderDeliveredPayload {orderId}`, `DispatchFailedPayload {orderId, reason}`),
  `DispatchView` (read model: `{orderId, tenantId, status, driverId?, offeredDriverId?, updatedAt, ...timestamps}`).
- `dispatchAggregateId(orderId)`, `driverOnlineKey(tenant)`, `driverBusyKey(tenant)` helpers.
- `.avsc` files for the 5 new events + `SUBJECTS` entries (topic `dispatch-events`, `TopicRecordNameStrategy`).
- `contracts.spec.ts` extended for the new constants.

### shared (`@flashbite/shared`)
- Generalize `appendWithExpectedVersion`: add optional `topic?: string` to `AppendArgs` (default
  `TOPICS.ORDER_EVENTS`); the outbox row uses it. Dispatch appends pass `TOPICS.DISPATCH_EVENTS`.
  (partitionKey stays `${tenantId}:${aggregateId}` → `${tenant}:dispatch:<orderId>`, preserving per-dispatch order.)
- New `dispatch-aggregate.ts` (+ spec) as described above.

### saga-worker (one process, second workflow)
- `dispatch-workflow.ts`: `driverDispatchWorkflow` + signal definitions (accept/reject/pickup/deliver,
  each `[driverId]`).
- `dispatch-activities.ts`: `selectNearestAvailableDriverActivity`, `markBusyActivity`/`clearBusyActivity`
  (Redis via a `RedisService`/cluster), and the event-append activities (`recordDriverOfferedActivity`,
  `recordDispatchAcceptedActivity`, `recordOrderPickedUpActivity`, `recordOrderDeliveredActivity`,
  `recordDispatchFailedActivity`) using `loadAggregate(...foldDispatch...)` + `appendWithExpectedVersion(topic: DISPATCH_EVENTS)`.
- `main.ts`: register `driverDispatchWorkflow` + dispatch activities in the worker; add a **second Kafka
  consumer** (new consumer group `dispatch-starter`) on `order-events` that, on `OrderAccepted`, starts
  `driverDispatchWorkflow` (workflowId `dispatch:<tenant>:<orderId>`, args `{tenantId, orderId, offerTimeoutSeconds, maxOffers}`).
  Add a Redis client to the worker for the selection/busy activities.

### write-api (driver command endpoints)
- `dispatch.controller.ts` (driver role): `POST /dispatch/:orderId/{accept|reject|pickup|deliver}` →
  `handle.signal(<signal>, driverId)` on workflow `dispatch:<tenant>:<orderId>`; not-found → 404
  (mirrors `accept.controller.ts`). `driverId` from the request (body/JWT-sub; see simplification),
  tenant from JWT.

### read-api (online toggle + dispatch reads)
- Driver online toggle on the drivers controller (consistent with telemetry living on read-api):
  `POST /drivers/:driverId/online` · `/offline` (driver role) → `SADD`/`SREM` `driverOnlineKey(tenant)`.
- `GET /orders/:orderId/dispatch` (authenticated, tenant-scoped) → `DispatchView | { status: null }`
  from the dispatches read model (assigned/offered driver + status).
- `GET /driver/dispatch?driverId=…` (driver role) → the driver's current offer (`status OFFERED` &
  `offeredDriverId = me`) or active job (`driverId = me` & status in {DISPATCHED, PICKED_UP}), or null.

### projection-worker (dispatch read model)
- A second consumer (group `dispatch-projection`) on `dispatch-events` → a Mongo `dispatches` collection
  (`READ_COLLECTIONS.DISPATCHES`), folded by event type (version-guarded, inbox-deduped like orders):
  `DriverOffered`→{status:OFFERED, offeredDriverId}, `DispatchAccepted`→{status:DISPATCHED, driverId},
  `OrderPickedUp`→PICKED_UP, `OrderDelivered`→DELIVERED, `DispatchFailed`→{status:FAILED, reason}.
- `rebuild.ts` extended (or a sibling) to rebuild the dispatches read model.

### config (`packages/shared/src/config.ts`) + `.env.example`
- `dispatchOfferTimeoutSeconds` (`DISPATCH_OFFER_TIMEOUT_SECONDS`, default 30).
- `dispatchMaxOffers` (`DISPATCH_MAX_OFFERS`, default 5).

### infra / CI
- `register:schemas` already registers all `SUBJECTS` — the 5 new dispatch `.avsc` are picked up
  automatically. Add `dispatch-events` to any topic pre-creation + the `infra`/CI doc.

## Testing

- **dispatch-aggregate.spec** (pure): fold + each command's legal/illegal transitions.
- **contracts.spec**: new constants/subjects.
- **dispatch-workflow.spec** (Temporal time-skipping, stubbed activities): accept-first-offer → DELIVERED
  path; reject → re-offer → accept; all-timeout/reject → `DispatchFailed`; no-candidate → `DispatchFailed`;
  stale-driver signal ignored. Assert the `tried` driver is never re-offered.
- **dispatch e2e** (live Temporal + Postgres + Redis): seed an online driver in the geo+online sets, start
  the workflow, signal accept→pickup→deliver, assert the `dispatch:<orderId>` event stream is
  `[DriverOffered, DispatchAccepted, OrderPickedUp, OrderDelivered]` and the driver leaves the busy set.
- **read-api e2e**: online/offline toggle SADD/SREM; `GET /orders/:id/dispatch` returns the projected view /
  null; tenant-scoping.
- **write-api e2e**: each dispatch signal endpoint is driver-role-gated and 404s with no workflow.
- **projection**: dispatch-events fold into the `dispatches` collection.

## Scope boundary / backlog

- Driver job UI + online toggle UI (**3d-ii**); customer live driver-location tracking (**3d-iii**).
- Per-order pickup/delivery coordinates (dispatch around real points, not city center).
- Geo freshness TTL / "recently pinged" availability; binding `driverId` to the JWT `sub`.
- `DispatchFailed` requeue/refund; driver cancel-after-accept / reassignment; ETA estimation.
- A separate deployable `dispatch-worker` (only if dispatch grows to warrant independent scaling/ownership).

## Success criteria

1. On `OrderAccepted`, a `driverDispatchWorkflow` starts and offers the job to the nearest online, idle
   driver; the `DriverDispatch` aggregate stream records `DriverOffered`.
2. The offered driver accepting drives `DispatchAccepted → OrderPickedUp → OrderDelivered`; rejecting or
   timing out re-offers to the next-nearest, never re-offering a passed driver; exhaustion →
   `DispatchFailed(NO_DRIVERS_AVAILABLE)`.
3. Availability honors the explicit online toggle and the busy set (an accepted driver isn't offered
   another job until delivered).
4. Dispatch is a separate aggregate/topic/read model; the `Order` aggregate and event stream are
   unchanged; everything runs in the existing `saga-worker` process.
5. New + existing suites green; `dispatch-events` schemas registered; CI provisions the topic.
