# FlashBite Phase 3a — Full Event Sourcing (Design Spec)

**Date:** 2026-06-18
**Status:** Approved (pending spec review)
**Phase:** First slice of Phase 3 ("deepen every box to hard mode"). Builds on Phase 0+1+2.

## Phase 3 context (slice map)

Phase 3 hardens each box. It is built in slices, each its own spec → plan → PR:

| Slice | Deliverable | Status |
|------|-------------|--------|
| **3a (this)** | Full event sourcing: an Order **aggregate** (rehydrate + invariants + optimistic concurrency) replacing blind appends, + projection rebuild | this spec |
| 3b | Avro + Schema Registry (replace JSON Kafka envelopes) | later |
| 3c | Real payments (replace the fake charge/refund activities) | later |
| 3d | Driver dispatch (close the order↔driver loop) | later |

3a is foundational: it hardens the write model that 3d's new commands (driver accept/pickup/deliver) will build on. It is pure-backend — no external dependencies, no frontend changes.

## Goal

Replace the current "blind append" write model with a real **Order aggregate**: rehydrate state from the event stream, enforce state-transition invariants, and append new events with **optimistic concurrency** (expected-version). Add a **projection-rebuild** path that reconstructs the Mongo read model from the event store, demonstrating the rebuildable-read-model property of event sourcing.

## Problem (current state)

- `apps/write-api/src/orders/orders.service.ts` `placeOrder` always appends `OrderPlaced` at **version 1** inside a `withTenantTransaction`, catching `P2002` for idempotency. It never loads the order's state.
- `packages/shared/src/event-store.ts` `appendEvent` (used by the saga activities) computes `version = max + 1` via `findFirst` and appends **without loading or validating** the aggregate's state. Nothing prevents an invalid transition — e.g., the saga's SLA-breach `OrderCancelled` and a merchant-accept `OrderAccepted` racing both append, or an `OrderAccepted` after a cancel.

The `event_store` table already has `@@unique([tenantId, aggregateId, version])` (optimistic-concurrency primitive) and is append-only; 3a builds the aggregate layer on top.

## Scope

**In:**
- A generic event-sourcing store in `@flashbite/shared`: `loadAggregate` (rehydrate) + `appendWithExpectedVersion` (optimistic-concurrency append, atomic with the outbox, under RLS) + a typed `ConcurrencyError`.
- A pure `Order` aggregate in `@flashbite/shared`: `foldOrder` reducer + `place`/`accept`/`cancel` command functions enforcing invariants + a typed `InvalidTransitionError`.
- Rewire `write-api` `placeOrder` and the two saga activities (`recordOrderAccepted`, `recordOrderCancelled`) onto the aggregate.
- A `rebuild:projection` script replaying `event_store` → Mongo `orders` read model.
- Tests (unit + e2e) per §Testing.

**Out (backlog notes):**
- **Snapshots** — orders have ≤3 events; replaying the full stream is trivial. Note in backlog.
- **Generic command bus / aggregate base class** — one aggregate doesn't justify a framework. The load/append infra is generic; the `Order` domain is specific.
- No Avro (3b), no payments (3c), no dispatch (3d). No frontend changes. Telemetry stays non-aggregate/ephemeral.

## Architecture

The aggregate reducer + command functions are **pure** (no node/db deps) and live in `@flashbite/shared` — NOT in `@flashbite/contracts`, because `contracts` must stay importable by the Temporal **workflow** bundle and the aggregate is only used by **activities** (saga worker) and **write-api**, both of which already depend on `@flashbite/shared`. The store does the DB work, wrapping every write in S2's `withTenantTransaction` so the RLS `app.tenant_id` GUC is set.

```
@flashbite/shared
  aggregate-store.ts   loadAggregate(...) + appendWithExpectedVersion(...) + ConcurrencyError
  order-aggregate.ts   OrderState + foldOrder() + place()/accept()/cancel() + InvalidTransitionError
```

## Components

### 1. `packages/shared/src/aggregate-store.ts` (generic)

```ts
export class ConcurrencyError extends Error {}

export interface LoadedAggregate<S> { state: S; version: number }

// Replays event_store rows (tenant + aggregateId) ordered by version, folding payloads.
export async function loadAggregate<S>(
  prisma: PrismaClient,
  args: { tenantId: string; aggregateId: string },
  fold: (state: S, event: { eventType: string; payload: unknown; version: number }) => S,
  initial: S,
): Promise<LoadedAggregate<S>>;

// Appends one event at version = expectedVersion + 1, atomically with the outbox row,
// inside withTenantTransaction (RLS). A unique-constraint (P2002) collision on
// (tenantId, aggregateId, version) is rethrown as ConcurrencyError.
export async function appendWithExpectedVersion(
  prisma: PrismaClient,
  args: {
    tenantId: string; aggregateType: string; aggregateId: string;
    expectedVersion: number; eventType: string; payload: unknown;
  },
): Promise<EventEnvelope>;
```

- `loadAggregate`: `findMany({ where: { tenantId, aggregateId }, orderBy: { version: "asc" } })`, fold each row's `{ eventType, payload, version }` into `state`; return `{ state, version: lastVersion }` (`version: 0`, `state: initial` if no events). Runs as the connected role; under RLS the read is tenant-scoped (write-api/saga connect as `flashbite_app`, which requires the GUC — so `loadAggregate` must also run inside the tenant GUC; it is invoked within the same `withTenantTransaction` as the append, OR sets the GUC for its read — see note below).
- `appendWithExpectedVersion`: inside `withTenantTransaction(prisma, tenantId, async (tx) => { … })`, `tx.eventStore.create({ version: expectedVersion + 1, … })` + `tx.outbox.create({ … envelope … })` (mirrors today's `appendEvent` outbox shape: `topic = order-events`, `partitionKey = tenantId:aggregateId`, `payload = full envelope`). On `Prisma P2002` → `throw new ConcurrencyError(...)`.
- **RLS note:** `loadAggregate` + the append must both see the tenant GUC. Cleanest: a single helper `loadAndAppend` is *not* required — instead, callers run `loadAggregate` and `appendWithExpectedVersion` and both set the GUC. To keep reads tenant-scoped under RLS, `loadAggregate` wraps its read in `withTenantTransaction` too (set GUC, then read). (The superuser-connected poller never calls these.) This keeps each call self-contained.

### 2. `packages/shared/src/order-aggregate.ts` (pure domain)

```ts
export type OrderStatus = "PLACED" | "ACCEPTED" | "CANCELLED";

export interface OrderState {
  status: OrderStatus | null;   // null = does not exist yet
  customerId?: string;
  items?: OrderItem[];
  totalAmount?: number;
  cancelReason?: string;
}

export const INITIAL_ORDER_STATE: OrderState = { status: null };

export class InvalidTransitionError extends Error {}

export function foldOrder(state: OrderState, event: { eventType: string; payload: unknown }): OrderState;
// OrderPlaced -> { status: PLACED, customerId, items, totalAmount }
// OrderAccepted -> { ...state, status: ACCEPTED }
// OrderCancelled -> { ...state, status: CANCELLED, cancelReason }

// Command functions: return the payload to append, or signal idempotent no-op / throw InvalidTransitionError.
export function placeOrder(state: OrderState, cmd: OrderPlacedPayload): OrderPlacedPayload | null; // null = already exists (idempotent)
export function acceptOrder(state: OrderState): OrderAcceptedPayload;   // throws if status !== PLACED
export function cancelOrder(state: OrderState, reason: string): OrderCancelledPayload; // throws if status !== PLACED
```

Invariants:
- `placeOrder`: `state.status !== null` → return `null` (order exists; idempotent re-place).
- `acceptOrder`: `state.status !== "PLACED"` → `throw new InvalidTransitionError("cannot accept order in status " + state.status)`.
- `cancelOrder`: `state.status !== "PLACED"` → `throw new InvalidTransitionError(...)`.

### 3. write-api `placeOrder` (rewired)

```ts
const tenantId = getTenantId();
const { state, version } = await loadAggregate(this.prisma, { tenantId, aggregateId: dto.orderId }, foldOrder, INITIAL_ORDER_STATE);
const payload = placeOrder(state, { orderId: dto.orderId, customerId: dto.customerId, items: dto.items, totalAmount: dto.totalAmount });
if (payload === null) return { orderId: dto.orderId };           // idempotent
try {
  await appendWithExpectedVersion(this.prisma, { tenantId, aggregateType: ORDER, aggregateId: dto.orderId, expectedVersion: version, eventType: ORDER_PLACED, payload });
} catch (err) {
  if (err instanceof ConcurrencyError) return { orderId: dto.orderId }; // concurrent first-write → idempotent outcome
  throw err;
}
return { orderId: dto.orderId };
```
(A concurrent first-write race on `place` resolves to the same idempotent `{ orderId }` — both callers asked for the same order.)

### 4. saga activities (rewired, race-safe)

`recordOrderAcceptedActivity(tenantId, orderId)`:
```ts
const { state, version } = await loadAggregate(prisma, { tenantId, aggregateId: orderId }, foldOrder, INITIAL_ORDER_STATE);
let payload;
try { payload = acceptOrder(state); }
catch (e) { if (e instanceof InvalidTransitionError) return; /* already terminal: benign no-op */ throw e; }
await appendWithExpectedVersion(prisma, { tenantId, aggregateType: ORDER, aggregateId: orderId, expectedVersion: version, eventType: ORDER_ACCEPTED, payload });
```
`recordOrderCancelledActivity(tenantId, orderId, reason)`: same shape with `cancelOrder(state, reason)` → `ORDER_CANCELLED`.

- `InvalidTransitionError` → `return` (no event; workflow proceeds cleanly). This is the SLA-vs-accept race loser being safely dropped.
- `ConcurrencyError` propagates → **Temporal retries the activity** (default retry policy); on retry it reloads, the order is typically now terminal → `InvalidTransitionError` → benign no-op.
- The workflow (`workflow.ts`) is unchanged. The old `appendEvent` is removed (replaced by the aggregate path); update its callers + spec.

### 5. Projection rebuild

`apps/projection-worker/src/rebuild.ts` + root script `rebuild:projection`:
- Connect Mongo + Postgres (privileged `DATABASE_URL` — cross-tenant read of the whole store).
- Optionally clear the `orders` collection (a `--fresh` flag; default clears so the rebuild is authoritative).
- Read all `event_store` rows ordered by `(tenantId, aggregateId, version)`; for each, apply the **same projection logic** the `projection-worker` uses to upsert the `orders` read model (version-guarded, idempotent). Reuse the existing apply function (extract it if currently inline) so rebuild and live projection share one code path.
- Print a summary (events replayed, orders rebuilt).

Root `package.json`: `"rebuild:projection": "node -r @swc-node/register -r tsconfig-paths/register --env-file=.env apps/projection-worker/src/rebuild.ts"`.

## Data flow

**Place (idempotent, optimistic):**
```
POST /orders (customer JWT)
  loadAggregate(tenantId:orderId)  -> { state, version }
  placeOrder(state, cmd): exists ? null : OrderPlaced
  null -> 201 { orderId } (idempotent)
  else -> appendWithExpectedVersion(expected=version=0, OrderPlaced)  [RLS tx: event_store v1 + outbox]
          ConcurrencyError -> 201 { orderId } (concurrent first-write, same order)
```

**Saga accept (race-safe):**
```
merchant accept signal -> workflow -> recordOrderAcceptedActivity
  loadAggregate -> { state, version }
  acceptOrder(state): status===PLACED ? OrderAccepted : throw InvalidTransition
  ok -> appendWithExpectedVersion(expected=version, OrderAccepted)
  InvalidTransition (already CANCELLED via SLA) -> no-op, workflow completes
  ConcurrencyError -> activity throws -> Temporal retries -> reload -> now terminal -> no-op
```

## Error handling

- `ConcurrencyError` (transient version conflict): write-api maps to **409** for non-idempotent commands (place resolves idempotently as above); saga activity is **retried** by Temporal.
- `InvalidTransitionError` (permanent domain rejection): saga **drops** it (benign no-op); a direct write-api command path (none today beyond place) would return **409** with the current status.
- The atomic event+outbox write and the existing idempotency guarantees are preserved; the unique constraint remains the concurrency backstop.

## Testing

- **Unit (Jest):**
  - `foldOrder`: each event type folds correctly; unknown event leaves state unchanged.
  - `placeOrder`/`acceptOrder`/`cancelOrder`: place-on-existing → `null`; accept/cancel on non-PLACED → `InvalidTransitionError`; valid transitions return the right payload.
  - `loadAggregate`: replays a seeded stream → correct `{ state, version }`; empty stream → `{ initial, 0 }`.
  - `appendWithExpectedVersion`: appends at `expected+1`; a second append at the same expected version → `ConcurrencyError`.
- **e2e (infra up, run as `flashbite_app` via inline `APP_DATABASE_URL`):**
  - Re-place same orderId → idempotent (one event_store row, one outbox row) — preserves current behavior.
  - **Race safety:** seed `OrderPlaced` then `OrderCancelled` (SLA), then run the accept activity/path → it is a no-op; the store holds exactly one terminal event; status stays CANCELLED.
  - **Optimistic concurrency:** two `appendWithExpectedVersion` calls at the same expected version → exactly one succeeds, the other throws `ConcurrencyError`.
  - **Projection rebuild:** place + accept a couple of orders, wipe the Mongo `orders` collection, run `rebuild:projection`, assert the read model is reconstructed identically (same statuses/versions).
  - Existing write-api e2e (place/idempotent/400/401/403/tenant-from-token) and saga e2e (accept, SLA-breach) stay green.

## Open assumptions

- One aggregate type (`ORDER`). Telemetry is not event-sourced (ephemeral geo) and is untouched.
- `loadAggregate` runs under the tenant RLS GUC (set via `withTenantTransaction`) for write-api/saga; the rebuild script uses the privileged superuser connection (cross-tenant, like the poller).
- No snapshots, no generic command bus (backlog). The `Order` aggregate is hand-written; the store helpers are generic and reusable by future aggregates (e.g., 3d driver/dispatch).
- Order amounts/items are carried in `OrderPlaced`; the aggregate keeps them in state for future commands (e.g., refund amount in 3c) but 3a doesn't add new events.
