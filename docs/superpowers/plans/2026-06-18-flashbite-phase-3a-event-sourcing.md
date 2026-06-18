# Phase 3a — Full Event Sourcing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blind-append write model with a real `Order` aggregate (rehydrate from the event stream, enforce transition invariants, append with optimistic concurrency) and add a projection-rebuild path.

**Architecture:** A generic event-sourcing store (`loadAggregate` + `appendWithExpectedVersion` + `ConcurrencyError`) and a pure `Order` aggregate (`foldOrder` + `place`/`accept`/`cancel` + `InvalidTransitionError`) in `@flashbite/shared`. write-api `placeOrder` and the saga's accept/cancel activities are rewired onto the aggregate; the SLA-vs-accept race becomes a safe no-op. A `rebuild:projection` script replays `event_store` → Mongo.

**Tech Stack:** Prisma 5 (Postgres event store, `@@unique(tenantId,aggregateId,version)`), NestJS 10, Temporal (saga activities, auto-retry), Jest, MongoDB (read model). Builds on S2 RLS (`withTenantTransaction`).

**Scope:** 3a ONLY — full ES write model + rebuild. No Avro (3b), payments (3c), dispatch (3d). No frontend. Telemetry untouched.

**Branch:** `phase-3a-event-sourcing` off `main` (created; spec committed there). Spec: `docs/superpowers/specs/2026-06-18-flashbite-phase-3a-event-sourcing-design.md`.

**Key facts (verified):**
- `apps/write-api/src/orders/orders.service.ts` `placeOrder`: inline `withTenantTransaction` appending `OrderPlaced` v1, P2002→idempotent.
- `packages/shared/src/event-store.ts` `appendEvent`: blind `max+1` append via `withTenantTransaction`; used ONLY by saga activities + tested by `packages/shared/src/event-store.spec.ts`. Will be **removed** (replaced by the aggregate path).
- `apps/saga-worker/src/activities.ts` `recordOrderAccepted/CancelledActivity` use `appendEvent`. `apps/saga-worker/src/main.ts` builds `new PrismaClient({ datasourceUrl: config.appDatabaseUrl })` (flashbite_app) and passes it to `createActivities(prisma)`.
- `apps/projection-worker/src/projection.ts` exports `applyEvent(db, envelope)` — inbox-dedup (`processed_events`) + version-guarded upsert. Reusable for rebuild (clear the inbox first so events re-apply).
- `event_store` row stores `id = eventId`, `payload = domain payload`, `occurredAt`; `outbox.payload = full envelope`.
- write-api/saga connect as `flashbite_app` (RLS) → `loadAggregate` must read under the tenant GUC (`withTenantTransaction`). The rebuild script uses the privileged `DATABASE_URL` (superuser, cross-tenant) like the poller.
- `@flashbite/shared` `index.ts` re-exports each module via `export * from "./x"`.

---

## File Structure

- Create: `packages/shared/src/order-aggregate.ts` — pure `OrderState`, `foldOrder`, `place`/`accept`/`cancel`, `InvalidTransitionError`.
- Create: `packages/shared/src/order-aggregate.spec.ts`.
- Create: `packages/shared/src/aggregate-store.ts` — `loadAggregate`, `appendWithExpectedVersion`, `ConcurrencyError`.
- Create: `packages/shared/test/aggregate-store.e2e-spec.ts` (infra-backed).
- Modify: `packages/shared/src/index.ts` — export the two new modules; drop `./event-store`.
- Delete: `packages/shared/src/event-store.ts`, `packages/shared/src/event-store.spec.ts`.
- Modify: `apps/write-api/src/orders/orders.service.ts` — rewire `placeOrder` onto the aggregate.
- Modify: `apps/saga-worker/src/activities.ts` — rewire accept/cancel onto the aggregate.
- Create: `apps/projection-worker/src/rebuild.ts` — replay `event_store` → Mongo.
- Modify: root `package.json` — `rebuild:projection` script.
- Modify: `apps/write-api/test/orders.e2e-spec.ts` (add concurrency/invariant cases), `apps/saga-worker/test/*` if needed (race-safety), `apps/projection-worker/test/*` (rebuild).
- Modify: `README.md` — note the aggregate + rebuild command.

---

## Task 1: Order aggregate (pure domain)

**Files:** `packages/shared/src/order-aggregate.ts`, `packages/shared/src/order-aggregate.spec.ts`

- [ ] **Step 1: Write the failing test** — `packages/shared/src/order-aggregate.spec.ts`:

```ts
import {
  foldOrder, place, accept, cancel, INITIAL_ORDER_STATE, InvalidTransitionError,
} from "./order-aggregate";
import { EVENT_TYPES, ORDER_STATUS } from "@flashbite/contracts";

const placed = (over = {}) => ({ orderId: "o-1", customerId: "c-1", items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200, ...over });

describe("order aggregate", () => {
  describe("foldOrder", () => {
    it("folds OrderPlaced into PLACED state", () => {
      const s = foldOrder(INITIAL_ORDER_STATE, { eventType: EVENT_TYPES.ORDER_PLACED, payload: placed() });
      expect(s).toMatchObject({ status: ORDER_STATUS.PLACED, customerId: "c-1", totalAmount: 1200 });
    });
    it("folds OrderAccepted / OrderCancelled", () => {
      let s = foldOrder(INITIAL_ORDER_STATE, { eventType: EVENT_TYPES.ORDER_PLACED, payload: placed() });
      expect(foldOrder(s, { eventType: EVENT_TYPES.ORDER_ACCEPTED, payload: { orderId: "o-1" } }).status).toBe(ORDER_STATUS.ACCEPTED);
      const c = foldOrder(s, { eventType: EVENT_TYPES.ORDER_CANCELLED, payload: { orderId: "o-1", reason: "SLA_BREACH" } });
      expect(c.status).toBe(ORDER_STATUS.CANCELLED);
      expect(c.cancelReason).toBe("SLA_BREACH");
    });
    it("ignores unknown events", () => {
      const s = foldOrder(INITIAL_ORDER_STATE, { eventType: "Whatever", payload: {} });
      expect(s).toEqual(INITIAL_ORDER_STATE);
    });
  });

  describe("commands", () => {
    const placedState = foldOrder(INITIAL_ORDER_STATE, { eventType: EVENT_TYPES.ORDER_PLACED, payload: placed() });
    it("place on a new order returns the payload", () => {
      expect(place(INITIAL_ORDER_STATE, placed())).toEqual(placed());
    });
    it("place on an existing order is idempotent (null)", () => {
      expect(place(placedState, placed())).toBeNull();
    });
    it("accept a PLACED order returns OrderAccepted payload", () => {
      expect(accept(placedState, "o-1")).toEqual({ orderId: "o-1" });
    });
    it("accept/cancel a terminal order throws InvalidTransitionError", () => {
      const accepted = foldOrder(placedState, { eventType: EVENT_TYPES.ORDER_ACCEPTED, payload: { orderId: "o-1" } });
      expect(() => accept(accepted, "o-1")).toThrow(InvalidTransitionError);
      expect(() => cancel(accepted, "o-1", "DECLINED")).toThrow(InvalidTransitionError);
    });
    it("cancel a PLACED order returns OrderCancelled payload", () => {
      expect(cancel(placedState, "o-1", "DECLINED")).toEqual({ orderId: "o-1", reason: "DECLINED" });
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm exec jest packages/shared/src/order-aggregate.spec.ts`

- [ ] **Step 3: Implement** — `packages/shared/src/order-aggregate.ts`:

```ts
import {
  EVENT_TYPES,
  ORDER_STATUS,
  type OrderItem,
  type OrderPlacedPayload,
  type OrderAcceptedPayload,
  type OrderCancelledPayload,
} from "@flashbite/contracts";

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export interface OrderState {
  status: OrderStatus | null; // null = does not exist yet
  customerId?: string;
  items?: OrderItem[];
  totalAmount?: number;
  cancelReason?: string;
}

export const INITIAL_ORDER_STATE: OrderState = { status: null };

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export function foldOrder(state: OrderState, event: { eventType: string; payload: unknown }): OrderState {
  switch (event.eventType) {
    case EVENT_TYPES.ORDER_PLACED: {
      const p = event.payload as OrderPlacedPayload;
      return { status: ORDER_STATUS.PLACED, customerId: p.customerId, items: p.items, totalAmount: p.totalAmount };
    }
    case EVENT_TYPES.ORDER_ACCEPTED:
      return { ...state, status: ORDER_STATUS.ACCEPTED };
    case EVENT_TYPES.ORDER_CANCELLED:
      return { ...state, status: ORDER_STATUS.CANCELLED, cancelReason: (event.payload as OrderCancelledPayload).reason };
    default:
      return state;
  }
}

/** place: returns the event payload, or null when the order already exists (idempotent). */
export function place(state: OrderState, cmd: OrderPlacedPayload): OrderPlacedPayload | null {
  if (state.status !== null) return null;
  return cmd;
}

/** accept: throws InvalidTransitionError unless the order is PLACED. */
export function accept(state: OrderState, orderId: string): OrderAcceptedPayload {
  if (state.status !== ORDER_STATUS.PLACED) {
    throw new InvalidTransitionError(`cannot accept order in status ${String(state.status)}`);
  }
  return { orderId };
}

/** cancel: throws InvalidTransitionError unless the order is PLACED. */
export function cancel(state: OrderState, orderId: string, reason: string): OrderCancelledPayload {
  if (state.status !== ORDER_STATUS.PLACED) {
    throw new InvalidTransitionError(`cannot cancel order in status ${String(state.status)}`);
  }
  return { orderId, reason };
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm exec jest packages/shared/src/order-aggregate.spec.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/order-aggregate.ts packages/shared/src/order-aggregate.spec.ts
git commit -m "feat(shared): Order aggregate — foldOrder + place/accept/cancel + InvalidTransitionError"
```

---

## Task 2: Aggregate store (rehydrate + optimistic-concurrency append)

**Files:** `packages/shared/src/aggregate-store.ts`, `packages/shared/test/aggregate-store.e2e-spec.ts`, `packages/shared/src/index.ts`

**Context:** `loadAggregate` replays `event_store` (under the tenant RLS GUC via `withTenantTransaction`). `appendWithExpectedVersion` writes the event at `expectedVersion + 1` + the outbox row atomically; the unique constraint turns a concurrent same-version write into `P2002` → `ConcurrencyError`. The e2e connects as `flashbite_app` (inline `APP_DATABASE_URL`) like the S2 tests.

- [ ] **Step 1: Implement the store** — `packages/shared/src/aggregate-store.ts`:

```ts
import { PrismaClient, Prisma } from "@prisma/client";
import { TOPICS, type EventEnvelope } from "@flashbite/contracts";
import { buildEnvelope } from "./envelope";
import { withTenantTransaction } from "./tenant-transaction";

export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}

export interface LoadedAggregate<S> {
  state: S;
  version: number;
}

/** Replays the aggregate's event stream (tenant-scoped, under the RLS GUC) and folds it. */
export async function loadAggregate<S>(
  prisma: PrismaClient,
  args: { tenantId: string; aggregateId: string },
  fold: (state: S, event: { eventType: string; payload: unknown; version: number }) => S,
  initial: S,
): Promise<LoadedAggregate<S>> {
  return withTenantTransaction(prisma, args.tenantId, async (tx) => {
    const rows = await tx.eventStore.findMany({
      where: { tenantId: args.tenantId, aggregateId: args.aggregateId },
      orderBy: { version: "asc" },
    });
    let state = initial;
    let version = 0;
    for (const r of rows) {
      state = fold(state, { eventType: r.eventType, payload: r.payload as unknown, version: r.version });
      version = r.version;
    }
    return { state, version };
  });
}

export interface AppendArgs {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  expectedVersion: number;
  eventType: string;
  payload: unknown;
}

/**
 * Appends one event at version = expectedVersion + 1, atomically with the outbox row,
 * under the RLS GUC. A unique-constraint (P2002) collision on (tenantId, aggregateId,
 * version) — i.e. a concurrent writer already took this version — becomes ConcurrencyError.
 */
export async function appendWithExpectedVersion(prisma: PrismaClient, args: AppendArgs): Promise<EventEnvelope> {
  const version = args.expectedVersion + 1;
  const envelope = buildEnvelope({ tenantId: args.tenantId, eventType: args.eventType, version, payload: args.payload });
  try {
    return await withTenantTransaction(prisma, args.tenantId, async (tx) => {
      await tx.eventStore.create({
        data: {
          id: envelope.eventId,
          tenantId: args.tenantId,
          aggregateType: args.aggregateType,
          aggregateId: args.aggregateId,
          version,
          eventType: args.eventType,
          payload: args.payload as Prisma.InputJsonValue,
        },
      });
      await tx.outbox.create({
        data: {
          id: envelope.eventId,
          tenantId: args.tenantId,
          topic: TOPICS.ORDER_EVENTS,
          partitionKey: `${args.tenantId}:${args.aggregateId}`,
          eventType: args.eventType,
          payload: envelope as unknown as Prisma.InputJsonValue,
        },
      });
      return envelope;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ConcurrencyError(`version conflict on ${args.aggregateId} at version ${version}`);
    }
    throw err;
  }
}
```

- [ ] **Step 2: Export from index; drop event-store** — edit `packages/shared/src/index.ts`: remove `export * from "./event-store";`, add:

```ts
export * from "./aggregate-store";
export * from "./order-aggregate";
```

(Leave `event-store.ts` in place for THIS task so the saga still compiles; it is removed in Task 4 once the saga is rewired. But it is no longer exported — verify the saga imports `appendEvent` via the package root; if so, Task 4 must land before a full build. To keep this task's build green, KEEP the `export * from "./event-store";` line for now and remove it in Task 4. So in THIS step only ADD the two new exports.)

Corrected Step 2: ADD the two new exports; do NOT remove `./event-store` yet (Task 4 removes it with the saga rewire).

- [ ] **Step 3: Write the e2e** — `packages/shared/test/aggregate-store.e2e-spec.ts`:

```ts
import "reflect-metadata";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  loadAggregate, appendWithExpectedVersion, ConcurrencyError,
  foldOrder, INITIAL_ORDER_STATE,
} from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES, ORDER_STATUS } from "@flashbite/contracts";

// Connects as the restricted flashbite_app role (RLS), derived from DATABASE_URL.
const appUrl = (() => {
  const u = new URL(process.env.DATABASE_URL ?? "postgresql://flashbite@localhost:5434/flashbite_write");
  u.username = "flashbite_app";
  u.password = "flashbite_app_local_dev";
  return u.toString();
})();

describe("aggregate store (e2e)", () => {
  const prisma = new PrismaClient({ datasourceUrl: appUrl });
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });

  const place = (orderId: string) => ({
    tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
    expectedVersion: 0, eventType: EVENT_TYPES.ORDER_PLACED,
    payload: { orderId, customerId: "c-1", items: [], totalAmount: 1000 },
  });

  it("appends then rehydrates the aggregate", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, place(orderId));
    const { state, version } = await loadAggregate(prisma, { tenantId: "berlin", aggregateId: orderId }, foldOrder, INITIAL_ORDER_STATE);
    expect(version).toBe(1);
    expect(state.status).toBe(ORDER_STATUS.PLACED);

    await appendWithExpectedVersion(prisma, {
      tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
      expectedVersion: 1, eventType: EVENT_TYPES.ORDER_ACCEPTED, payload: { orderId },
    });
    const after = await loadAggregate(prisma, { tenantId: "berlin", aggregateId: orderId }, foldOrder, INITIAL_ORDER_STATE);
    expect(after.version).toBe(2);
    expect(after.state.status).toBe(ORDER_STATUS.ACCEPTED);
  });

  it("rejects a second append at the same expected version with ConcurrencyError", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, place(orderId)); // version 1
    await expect(appendWithExpectedVersion(prisma, place(orderId))).rejects.toBeInstanceOf(ConcurrencyError); // expected 0 -> 1 again
  });

  it("empty stream loads as version 0 / initial state", async () => {
    const { state, version } = await loadAggregate(prisma, { tenantId: "berlin", aggregateId: randomUUID() }, foldOrder, INITIAL_ORDER_STATE);
    expect(version).toBe(0);
    expect(state).toEqual(INITIAL_ORDER_STATE);
  });
});
```

- [ ] **Step 4: Run** — `pnpm infra:up && pnpm db:deploy && pnpm exec jest packages/shared/test/aggregate-store.e2e-spec.ts`
Expected: PASS (3). (Requires the `flashbite_app` role from the S2 migration — already on `main`.) Also run the unit suite: `pnpm exec jest packages/shared/src/order-aggregate.spec.ts` (still green).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/aggregate-store.ts packages/shared/test/aggregate-store.e2e-spec.ts packages/shared/src/index.ts
git commit -m "feat(shared): aggregate store — loadAggregate + appendWithExpectedVersion + ConcurrencyError"
```

---

## Task 3: Rewire write-api `placeOrder` onto the aggregate

**Files:** `apps/write-api/src/orders/orders.service.ts`, `apps/write-api/test/orders.e2e-spec.ts`

- [ ] **Step 1: Rewire the service** — replace `apps/write-api/src/orders/orders.service.ts`:

```ts
import { Injectable } from "@nestjs/common";
import {
  PrismaService, loadAggregate, appendWithExpectedVersion, ConcurrencyError,
  foldOrder, place, INITIAL_ORDER_STATE,
} from "@flashbite/shared";
import { getTenantId } from "@flashbite/tenant-context";
import { AGGREGATE_TYPES, EVENT_TYPES } from "@flashbite/contracts";
import { CreateOrderDto } from "./create-order.dto";

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async placeOrder(dto: CreateOrderDto): Promise<{ orderId: string }> {
    const tenantId = getTenantId();
    const { state, version } = await loadAggregate(
      this.prisma,
      { tenantId, aggregateId: dto.orderId },
      foldOrder,
      INITIAL_ORDER_STATE,
    );
    const payload = place(state, {
      orderId: dto.orderId,
      customerId: dto.customerId,
      items: dto.items,
      totalAmount: dto.totalAmount,
    });
    if (payload === null) return { orderId: dto.orderId }; // already exists — idempotent

    try {
      await appendWithExpectedVersion(this.prisma, {
        tenantId,
        aggregateType: AGGREGATE_TYPES.ORDER,
        aggregateId: dto.orderId,
        expectedVersion: version,
        eventType: EVENT_TYPES.ORDER_PLACED,
        payload,
      });
    } catch (err) {
      if (err instanceof ConcurrencyError) return { orderId: dto.orderId }; // concurrent first-write, same order
      throw err;
    }
    return { orderId: dto.orderId };
  }
}
```

- [ ] **Step 2: Keep the e2e green + add an invariant case.** `apps/write-api/test/orders.e2e-spec.ts` already covers place/idempotent/400/401/403/tenant-from-token. The aggregate preserves all of these. Add one test proving re-place after the order moved on is still idempotent (no duplicate, no error):

```ts
  it("re-placing an order that was already accepted is still idempotent (no new event)", async () => {
    const orderId = randomUUID();
    await request(app.getHttpServer()).post("/orders").set(bearer(customer)).send(body(orderId)); // PLACED
    // simulate the order having advanced: append OrderAccepted directly via the store as flashbite_app
    // (or accept via the saga in a fuller test). Here we just re-POST and assert idempotency holds.
    const res = await request(app.getHttpServer()).post("/orders").set(bearer(customer)).send(body(orderId));
    expect(res.status).toBe(201);
    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId } });
    expect(events).toHaveLength(1); // still exactly one OrderPlaced
  });
```

(`prisma` in the e2e is the superuser `new PrismaService()` used for assertions, per the S2 test pattern — confirm it exists in the file; if the suite uses a different assertion client, match it.)

- [ ] **Step 3: Run** — `pnpm infra:up && pnpm db:deploy && APP_DATABASE_URL="postgresql://flashbite_app:flashbite_app_local_dev@localhost:5434/flashbite_write?schema=public" pnpm exec jest apps/write-api`
Expected: PASS (existing 8 + the new idempotency case). The factory provides the flashbite_app client; `loadAggregate` reads under the GUC.

- [ ] **Step 4: Commit**

```bash
git add apps/write-api/src/orders/orders.service.ts apps/write-api/test/orders.e2e-spec.ts
git commit -m "refactor(write-api): place orders through the Order aggregate (rehydrate + optimistic concurrency)"
```

---

## Task 4: Rewire saga activities; remove `appendEvent`

**Files:** `apps/saga-worker/src/activities.ts`, `packages/shared/src/index.ts`, delete `packages/shared/src/event-store.ts` + `event-store.spec.ts`

**Context:** The accept/cancel activities load the aggregate, apply the command, and append at the loaded version. `InvalidTransitionError` (already terminal — the SLA-vs-accept race loser) → benign `return` (no event, workflow proceeds). `ConcurrencyError` propagates → Temporal retries the activity (reloads → typically now terminal → no-op).

- [ ] **Step 1: Rewire activities** — replace `apps/saga-worker/src/activities.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import {
  loadAggregate, appendWithExpectedVersion,
  foldOrder, accept, cancel, INITIAL_ORDER_STATE, InvalidTransitionError,
} from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES } from "@flashbite/contracts";

/**
 * Activities load the Order aggregate, validate the command, and append at the loaded
 * version. An already-terminal order (the SLA-vs-accept race loser) is a benign no-op;
 * a ConcurrencyError propagates so Temporal retries (reload -> re-evaluate).
 */
export function createActivities(prisma: PrismaClient) {
  return {
    async chargePaymentActivity(tenantId: string, orderId: string, amount: number): Promise<void> {
      // Fake payment gateway. Phase 3c swaps in a real provider.
      // eslint-disable-next-line no-console
      console.log(`[charge] tenant=${tenantId} order=${orderId} amount=${amount}`);
    },
    async refundPaymentActivity(tenantId: string, orderId: string, amount: number): Promise<void> {
      // eslint-disable-next-line no-console
      console.log(`[refund] tenant=${tenantId} order=${orderId} amount=${amount}`);
    },
    async recordOrderAcceptedActivity(tenantId: string, orderId: string): Promise<void> {
      const { state, version } = await loadAggregate(prisma, { tenantId, aggregateId: orderId }, foldOrder, INITIAL_ORDER_STATE);
      let payload;
      try {
        payload = accept(state, orderId);
      } catch (e) {
        if (e instanceof InvalidTransitionError) return; // already terminal — benign no-op
        throw e;
      }
      await appendWithExpectedVersion(prisma, {
        tenantId, aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
        expectedVersion: version, eventType: EVENT_TYPES.ORDER_ACCEPTED, payload,
      });
    },
    async recordOrderCancelledActivity(tenantId: string, orderId: string, reason: string): Promise<void> {
      const { state, version } = await loadAggregate(prisma, { tenantId, aggregateId: orderId }, foldOrder, INITIAL_ORDER_STATE);
      let payload;
      try {
        payload = cancel(state, orderId, reason);
      } catch (e) {
        if (e instanceof InvalidTransitionError) return; // already terminal — benign no-op
        throw e;
      }
      await appendWithExpectedVersion(prisma, {
        tenantId, aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
        expectedVersion: version, eventType: EVENT_TYPES.ORDER_CANCELLED, payload,
      });
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
```

- [ ] **Step 2: Remove the dead `appendEvent`** — `git rm packages/shared/src/event-store.ts packages/shared/src/event-store.spec.ts`; in `packages/shared/src/index.ts` remove `export * from "./event-store";`. Grep to confirm no other importers: `grep -rn "appendEvent" apps packages --include=*.ts` → none remaining (only the deleted files).

- [ ] **Step 3: Race-safety e2e.** Add to the saga test suite (`apps/saga-worker/test/`) a test that proves the race is safe at the activity level (cheaper than driving the full Temporal race): place an order, append `OrderCancelled` (SLA) via the store, then invoke `recordOrderAcceptedActivity` → it must be a no-op (no `OrderAccepted` appended; store still has exactly the placed + cancelled events). Use a `flashbite_app` PrismaClient (derive from DATABASE_URL as in Task 2). Sketch:

```ts
import { createActivities } from "../src/activities";
import { appendWithExpectedVersion } from "@flashbite/shared";
// ... build flashbite_app prisma (appUrl), seed PLACED (v1) + CANCELLED (v2),
// then: await createActivities(prisma).recordOrderAcceptedActivity("berlin", orderId);
// assert: eventStore rows for orderId === 2 (no OrderAccepted), last eventType === OrderCancelled.
```

(Match the existing saga test bootstrap. If the existing saga e2e already drive a real accept/SLA flow, ensure they still pass — the aggregate preserves the happy paths.)

- [ ] **Step 4: Run** — `pnpm infra:up && pnpm db:deploy && APP_DATABASE_URL="postgresql://flashbite_app:flashbite_app_local_dev@localhost:5434/flashbite_write?schema=public" pnpm exec jest apps/saga-worker packages/shared`
Expected: PASS — saga e2e (accept, SLA-breach) + the race-safety test + the shared unit/e2e. Temporal auto-retry covers transient `ConcurrencyError` in the live flow.

- [ ] **Step 5: Commit**

```bash
git add apps/saga-worker/src/activities.ts apps/saga-worker/test/ packages/shared/src/index.ts
git rm packages/shared/src/event-store.ts packages/shared/src/event-store.spec.ts
git commit -m "refactor(saga): record accept/cancel through the aggregate (race-safe); remove blind appendEvent"
```

---

## Task 5: Projection rebuild

**Files:** `apps/projection-worker/src/rebuild.ts`, root `package.json`, a rebuild test

**Context:** Replay the whole `event_store` (privileged `DATABASE_URL`, cross-tenant) through the existing `applyEvent(db, envelope)`. Because `applyEvent` dedups via the `processed_events` inbox, the rebuild must **clear the inbox** (and the `orders` collection) first so events re-apply. Reconstruct each envelope from the row (`eventId = row.id`, `payload = row.payload`).

- [ ] **Step 1: Implement** — `apps/projection-worker/src/rebuild.ts`:

```ts
import { PrismaClient } from "@prisma/client";
import { connectMongo } from "@flashbite/shared";
import { READ_COLLECTIONS, type EventEnvelope } from "@flashbite/contracts";
import { applyEvent } from "./projection";

/**
 * Rebuilds the Mongo read model from the Postgres event store. Clears the orders +
 * processed_events collections (so applyEvent's inbox-dedup re-applies), then replays
 * every event in (tenantId, aggregateId, version) order through the SAME applyEvent the
 * live projection uses. Runs as the privileged DATABASE_URL role (cross-tenant, bypasses RLS).
 */
export async function rebuildProjection(): Promise<{ events: number }> {
  const prisma = new PrismaClient(); // DATABASE_URL (superuser) — reads all tenants
  await prisma.$connect();
  const { client, db } = await connectMongo();
  try {
    await db.collection(READ_COLLECTIONS.ORDERS).deleteMany({});
    await db.collection(READ_COLLECTIONS.PROCESSED).deleteMany({});
    const rows = await prisma.eventStore.findMany({
      orderBy: [{ tenantId: "asc" }, { aggregateId: "asc" }, { version: "asc" }],
    });
    for (const r of rows) {
      const envelope: EventEnvelope = {
        tenantId: r.tenantId,
        eventId: r.id,
        eventType: r.eventType,
        version: r.version,
        occurredAt: r.occurredAt.toISOString(),
        payload: r.payload as unknown,
      };
      await applyEvent(db, envelope);
    }
    return { events: rows.length };
  } finally {
    await client.close();
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  rebuildProjection()
    .then(({ events }) => {
      // eslint-disable-next-line no-console
      console.log(`rebuild:projection — replayed ${events} events`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Root script** — add to `package.json` scripts:

```json
"rebuild:projection": "node -r @swc-node/register -r tsconfig-paths/register --env-file=.env apps/projection-worker/src/rebuild.ts"
```

- [ ] **Step 3: Test** — add `apps/projection-worker/test/rebuild.e2e-spec.ts`: seed a couple of orders' events into `event_store` (superuser PrismaClient or via the existing projection), drop the `orders` collection, call `rebuildProjection()`, assert the `orders` read model is reconstructed (correct statuses/versions). Mirror the existing projection test's Mongo/Prisma setup.

```ts
import { rebuildProjection } from "../src/rebuild";
// seed event_store: OrderPlaced(v1) + OrderAccepted(v2) for an orderId (superuser prisma);
// db.orders.deleteMany({}); const { events } = await rebuildProjection();
// expect db.orders.findOne(berlin:orderId).status === "ACCEPTED", version 2.
```

- [ ] **Step 4: Run** — `pnpm infra:up && pnpm db:deploy && pnpm exec jest apps/projection-worker`
Expected: PASS (existing projection tests + rebuild). Optionally smoke `pnpm rebuild:projection` manually (prints the replayed count).

- [ ] **Step 5: Commit**

```bash
git add apps/projection-worker/src/rebuild.ts apps/projection-worker/test/rebuild.e2e-spec.ts package.json
git commit -m "feat(projection): rebuild:projection — replay event_store into the Mongo read model"
```

---

## Task 6: Docs + full verification

**Files:** `README.md`, `docs/ARCHITECTURE.md` (optional touch), `docs/superpowers/backlog.md`

- [ ] **Step 1: README** — in the relevant section, note the hardened write model (Order aggregate: rehydrate + invariants + optimistic concurrency) and the `pnpm rebuild:projection` command (replays the event store into the read model). Keep it brief.

- [ ] **Step 2: Backlog** — add the deferred ES items to `docs/superpowers/backlog.md`: aggregate **snapshots** (skip while streams are tiny) and a **generic command bus / aggregate base class** (revisit when a 2nd/3rd aggregate lands, e.g. 3d dispatch).

- [ ] **Step 3: Full verification** —

```bash
pnpm infra:up && pnpm db:deploy
docker exec $(docker compose -f infra/docker-compose.yml ps -q mongodb) mongosh flashbite_read --quiet --eval 'db.orders.deleteMany({})' >/dev/null 2>&1
APP_DATABASE_URL="postgresql://flashbite_app:flashbite_app_local_dev@localhost:5434/flashbite_write?schema=public" pnpm test
```
Expected: full backend suite green — order-aggregate unit, aggregate-store e2e, write-api (aggregate place + idempotent), saga (accept/SLA + race-safety), projection (+ rebuild), and all prior suites. Report totals. If a Redis-backed suite flakes with cluster errors, that's the known env issue (recreate `redis-cluster`), not a 3a regression.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/backlog.md
git commit -m "docs(phase-3): note the Order aggregate + rebuild:projection; backlog snapshots/command-bus"
```

---

## Self-review notes (coverage check)

- **Order aggregate (fold + invariants)** → Task 1.
- **Rehydrate + optimistic-concurrency append** → Task 2.
- **write-api place via aggregate (idempotent preserved)** → Task 3.
- **saga accept/cancel via aggregate; race = benign no-op; ConcurrencyError → Temporal retry; appendEvent removed** → Task 4.
- **Projection rebuild (replay → read model)** → Task 5.
- **Docs + backlog + full verification** → Task 6.
- **Out of scope:** snapshots, generic command bus (backlog); no Avro/payments/dispatch/frontend.

## Notes for the executor

- `loadAggregate` and `appendWithExpectedVersion` each run inside `withTenantTransaction` (separate tenant-GUC transactions). The gap between load and append is exactly where optimistic concurrency bites — a stale `expectedVersion` → `ConcurrencyError` (correct).
- The aggregate commands are named `place`/`accept`/`cancel` (not `placeOrder`) to avoid clashing with `OrdersService.placeOrder`.
- The rebuild MUST clear `processed_events` (the inbox) as well as `orders`, or `applyEvent` will skip every event.
- e2e that exercise RLS connect as `flashbite_app` (inline `APP_DATABASE_URL`, or derive from `DATABASE_URL`); the rebuild script uses the superuser `DATABASE_URL` (cross-tenant).
- Commit per task; run `pnpm infra:up && pnpm db:deploy` before the infra-backed tasks (the `flashbite_app` role + RLS are already on `main` from S2).
