# FlashBite Phase 1c-i — Orchestration (Temporal Saga) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the order lifecycle with a Temporal saga — on `OrderPlaced`, start a workflow that charges payment, races an SLA timer against a merchant-approval signal, then either emits `OrderAccepted` or refunds and emits `OrderCancelled`; surface the result through the existing event → projection pipeline.

**Architecture:** A `saga-worker` runs a Temporal worker (workflow + activities) plus a Kafka consumer that starts one workflow per order (`WorkflowId = tenantId:orderId`). The workflow stays deterministic and calls activities for all I/O; the record-event activities append `OrderAccepted`/`OrderCancelled` to the Postgres event store + outbox (next version), so they flow through the existing outbox-poller → `order-events` → projection-worker, which updates the read-model status. `write-api` exposes a merchant-accept endpoint that signals the workflow.

**Tech Stack:** Temporal (`@temporalio/worker|client|workflow|activity|testing`), kafkajs, Prisma/Postgres, NestJS (write-api), Jest + ts-jest, @swc-node/register runtime.

---

## Context for the implementer

Phases 1a + 1b are done. Today: `write-api` writes `OrderPlaced` (event_store v1 + outbox); `outbox-poller` relays envelopes to `order-events`; `projection-worker` projects into Mongo (`orders`, status `PLACED`); `read-api` queries + SSE. Temporal runs at `localhost:7233` (Phase 0 infra).

**Before starting:** `pnpm infra:up`; confirm Postgres (5434), Redpanda (9092), MongoDB (27017), Redis Cluster (7100-7105), **Temporal (7233)** healthy (`pnpm infra:ps`). Master spec: `docs/superpowers/specs/2026-06-13-flashbite-showcase-design.md` (§3.2 orchestration plane, §4 SLA saga, §3.6 idempotency).

**Decisions locked (do not deviate without escalating):**
- **Workflow determinism:** `orderLifecycleWorkflow` imports ONLY `@temporalio/workflow` and the activity *types*. It must NOT import `@flashbite/contracts` (that module imports `node:crypto` via `buildEnvelope`, which breaks the Temporal workflow bundle). Event-type strings live inside the activities, not the workflow.
- **Events back through the outbox:** the `recordOrderAccepted`/`recordOrderCancelled` activities use the shared `appendEvent` helper (event_store + outbox in one Postgres tx, next version). No direct Kafka publish from the saga.
- **WorkflowId = `${tenantId}:${orderId}`**, `WorkflowIdReusePolicy.REJECT_DUPLICATE` — natural dedup (re-delivered `OrderPlaced` won't double-start).
- **SLA:** the workflow takes `slaSeconds` as an arg. The Kafka-start path uses `config.sagaSlaSeconds` (default 300). Breach tests start the workflow directly with a short SLA (or use the time-skipping test env).
- **Merchant approval = Temporal signal** `merchantApprovalSignal` (boolean: true=accept, false=decline). write-api's accept endpoint signals it.
- **saga-worker is plain TS** (Temporal worker + Kafka consumer), run via `@swc-node/register`. write-api stays NestJS (idiomatic DI, no `@Inject`).

**Conventions:** commit per task (Conventional Commits); UUIDs via `node:crypto`; tests `*.spec.ts`/`*.e2e-spec.ts` (root `jest.config.cjs`, serial + forceExit, loads `.env`).

---

## File Structure

```
flashbite/
  packages/
    contracts/src/index.ts        # MODIFY: OrderAccepted/Cancelled types+payloads, statuses
    shared/
      package.json                # MODIFY: add @flashbite/contracts, @temporalio/client
      src/config.ts               # MODIFY: temporalAddress, sagaSlaSeconds
      src/event-store.ts          # CREATE: appendEvent() helper
      src/temporal.ts             # CREATE: connectTemporal() helper
      src/index.ts                # MODIFY: re-exports
      src/config.spec.ts          # MODIFY
      src/event-store.spec.ts     # CREATE
      src/temporal.spec.ts        # CREATE
  apps/
    projection-worker/src/projection.ts   # MODIFY: handle Accepted/Cancelled
    projection-worker/test/projection.spec.ts  # MODIFY: add accepted/cancelled cases
    saga-worker/
      package.json                # CREATE
      tsconfig.json               # CREATE
      src/activities.ts           # CREATE: charge/refund/record activities
      src/workflows.ts            # CREATE: orderLifecycleWorkflow + signal
      src/main.ts                 # CREATE: worker + kafka starter
      test/activities.spec.ts     # CREATE
      test/workflow.spec.ts       # CREATE (@temporalio/testing)
      test/saga.e2e-spec.ts       # CREATE (live temporal + kafka)
    write-api/
      package.json                # MODIFY: add @temporalio/client
      src/temporal/temporal.service.ts  # CREATE
      src/orders/accept.controller.ts   # CREATE
      src/orders/orders.module.ts       # MODIFY: provide TemporalService + AcceptController
      test/accept.e2e-spec.ts     # CREATE
  infra/docker-compose.ci.yml     # MODIFY (Task 8): add temporal + temporal-postgres
  .github/workflows/test.yml      # MODIFY (Task 8): TEMPORAL_ADDRESS env
  package.json                    # MODIFY (Task 8): dev:saga script
```

---

## Task 1: contracts (Accepted/Cancelled) + config (temporal)

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/shared/src/config.ts`, `packages/shared/src/config.spec.ts`

- [ ] **Step 1: Extend the config test**

Replace the first `it` block body's assertions in `packages/shared/src/config.spec.ts` by replacing the whole file:
```ts
import { loadConfig } from "@flashbite/shared";

describe("loadConfig", () => {
  it("reads all settings from env with defaults", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5434/db",
      KAFKA_BROKERS: "localhost:9092",
      MONGO_URI: "mongodb://localhost:27017/flashbite_read",
      REDIS_CLUSTER_NODES: "127.0.0.1:7100,127.0.0.1:7101",
      TEMPORAL_ADDRESS: "localhost:7233",
      SAGA_SLA_SECONDS: "42",
    });
    expect(cfg.databaseUrl).toBe("postgresql://u:p@localhost:5434/db");
    expect(cfg.mongoUri).toBe("mongodb://localhost:27017/flashbite_read");
    expect(cfg.temporalAddress).toBe("localhost:7233");
    expect(cfg.sagaSlaSeconds).toBe(42);
  });

  it("defaults temporal + sla when unset", () => {
    const cfg = loadConfig({ DATABASE_URL: "x" });
    expect(cfg.temporalAddress).toBe("localhost:7233");
    expect(cfg.sagaSlaSeconds).toBe(300);
    expect(cfg.redisClusterNodes).toHaveLength(6);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 2: Run -> FAIL**

Run: `pnpm test -- packages/shared/src/config.spec.ts`
Expected: FAIL (`temporalAddress`/`sagaSlaSeconds` undefined).

- [ ] **Step 3: Extend config**

In `packages/shared/src/config.ts`, add to the `AppConfig` interface: `temporalAddress: string;` and `sagaSlaSeconds: number;`. In `loadConfig`'s returned object add:
```ts
    temporalAddress: env.TEMPORAL_ADDRESS ?? "localhost:7233",
    sagaSlaSeconds: Number(env.SAGA_SLA_SECONDS ?? 300),
```
(Keep all existing fields and the DATABASE_URL guard.)

- [ ] **Step 4: Add contracts for the new events**

Append to `packages/contracts/src/index.ts` (keep all existing exports; extend the existing `EVENT_TYPES` and `ORDER_STATUS` objects by REPLACING them with the expanded versions below, and add the new payloads):

Replace the existing `EVENT_TYPES` and `ORDER_STATUS` declarations with:
```ts
export const EVENT_TYPES = {
  ORDER_PLACED: "OrderPlaced",
  ORDER_ACCEPTED: "OrderAccepted",
  ORDER_CANCELLED: "OrderCancelled",
} as const;

export const ORDER_STATUS = {
  PLACED: "PLACED",
  ACCEPTED: "ACCEPTED",
  CANCELLED: "CANCELLED",
} as const;
```

Add these payload interfaces:
```ts
export interface OrderAcceptedPayload {
  orderId: string;
}

export interface OrderCancelledPayload {
  orderId: string;
  reason: string;
}
```

- [ ] **Step 5: Run -> PASS**

Run: `pnpm test -- packages/shared/src/config.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/shared/src/config.ts packages/shared/src/config.spec.ts
git commit -m "feat(contracts): OrderAccepted/Cancelled events + statuses; config temporal/sla"
```
End commit body with:
```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 2: projection-worker — project Accepted/Cancelled status

**Files:**
- Modify: `apps/projection-worker/src/projection.ts`
- Modify: `apps/projection-worker/test/projection.spec.ts`

- [ ] **Step 1: Add failing tests for the new transitions**

Append these tests inside the `describe("applyEvent", ...)` block in `apps/projection-worker/test/projection.spec.ts` (keep existing tests + imports; ensure `EVENT_TYPES` is imported):
```ts
  it("transitions an existing order to ACCEPTED on OrderAccepted (v2)", async () => {
    const orderId = randomUUID();
    await applyEvent(mongo.db, placed(orderId)); // v1 -> PLACED
    const accepted = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_ACCEPTED,
      version: 2,
      payload: { orderId },
    });
    const r = await applyEvent(mongo.db, accepted);
    expect(r).toBe("applied");

    const doc = await mongo.db.collection(READ_COLLECTIONS.ORDERS).findOne({ _id: `berlin:${orderId}` as never });
    expect(doc?.status).toBe("ACCEPTED");
    expect(doc?.version).toBe(2);

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` as never });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteMany({ tenantId: "berlin", consumer: "projection-worker", eventId: { $in: [placed(orderId).eventId, accepted.eventId] } } as never);
  });

  it("transitions an existing order to CANCELLED on OrderCancelled (v2)", async () => {
    const orderId = randomUUID();
    const place = placed(orderId);
    await applyEvent(mongo.db, place);
    const cancelled = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_CANCELLED,
      version: 2,
      payload: { orderId, reason: "SLA_BREACH" },
    });
    await applyEvent(mongo.db, cancelled);

    const doc = await mongo.db.collection(READ_COLLECTIONS.ORDERS).findOne({ _id: `berlin:${orderId}` as never });
    expect(doc?.status).toBe("CANCELLED");
    expect(doc?.version).toBe(2);

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` as never });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteMany({ tenantId: "berlin", consumer: "projection-worker", eventId: { $in: [place.eventId, cancelled.eventId] } } as never);
  });
```
(Note: the existing `placed()` helper builds a fresh envelope each call with a new eventId, so in the first new test capture it: change the cleanup to not re-call `placed(orderId)` — instead capture the placed envelope. Use this corrected first test body: build `const place = placed(orderId);` then `await applyEvent(mongo.db, place);` and reference `place.eventId` in cleanup, mirroring the second test.)

- [ ] **Step 2: Run -> FAIL**

Run: `pnpm test -- apps/projection-worker/test/projection.spec.ts`
Expected: FAIL — status stays `PLACED` (Accepted/Cancelled not handled).

- [ ] **Step 3: Extend applyEvent**

In `apps/projection-worker/src/projection.ts`, replace the single `if (envelope.eventType === EVENT_TYPES.ORDER_PLACED) { ... }` block with this branching (keep the inbox dedup before it and the inbox insert after it unchanged):
```ts
  const orders = db.collection(READ_COLLECTIONS.ORDERS);
  const _id = `${envelope.tenantId}:${(envelope.payload as { orderId: string }).orderId}`;

  if (envelope.eventType === EVENT_TYPES.ORDER_PLACED) {
    const p = envelope.payload as OrderPlacedPayload;
    const existing = await orders.findOne({ _id: _id as never });
    if (!existing || (existing.version as number) < envelope.version) {
      await orders.updateOne(
        { _id: _id as never },
        {
          $set: {
            tenantId: envelope.tenantId,
            orderId: p.orderId,
            customerId: p.customerId,
            items: p.items,
            totalAmount: p.totalAmount,
            status: ORDER_STATUS.PLACED,
            version: envelope.version,
            updatedAt: envelope.occurredAt,
          },
        },
        { upsert: true },
      );
    }
  } else if (
    envelope.eventType === EVENT_TYPES.ORDER_ACCEPTED ||
    envelope.eventType === EVENT_TYPES.ORDER_CANCELLED
  ) {
    const status =
      envelope.eventType === EVENT_TYPES.ORDER_ACCEPTED ? ORDER_STATUS.ACCEPTED : ORDER_STATUS.CANCELLED;
    const existing = await orders.findOne({ _id: _id as never });
    if (existing && (existing.version as number) < envelope.version) {
      await orders.updateOne(
        { _id: _id as never },
        { $set: { status, version: envelope.version, updatedAt: envelope.occurredAt } },
      );
    }
  }
  // Unknown event types fall through and are still marked processed (forward-compatible).
```
Ensure `ORDER_STATUS` is imported from `@flashbite/contracts` (add it to the existing import).

- [ ] **Step 4: Run -> PASS**

Run: `pnpm test -- apps/projection-worker/test/projection.spec.ts`
Expected: PASS (5 tests: original 3 + accepted + cancelled).

- [ ] **Step 5: Commit**

```bash
git add apps/projection-worker/src/projection.ts apps/projection-worker/test/projection.spec.ts
git commit -m "feat(projection-worker): project OrderAccepted/Cancelled -> read-model status"
```
End commit body with the `Co-Authored-By` line.

---

## Task 3: shared — appendEvent + connectTemporal helpers

**Files:**
- Modify: `packages/shared/package.json` (add `@flashbite/contracts`, `@temporalio/client`)
- Create: `packages/shared/src/event-store.ts`, `packages/shared/src/temporal.ts`
- Create: `packages/shared/src/event-store.spec.ts`, `packages/shared/src/temporal.spec.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add dependencies**

In `packages/shared/package.json` dependencies add (keep existing):
```json
    "ioredis": "5.4.1",
    "@flashbite/contracts": "workspace:*",
    "@temporalio/client": "1.11.1"
```
Then `pnpm install`.

- [ ] **Step 2: Write the failing appendEvent test**

Create `packages/shared/src/event-store.spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { appendEvent } from "@flashbite/shared";
import { EVENT_TYPES } from "@flashbite/contracts";

describe("appendEvent", () => {
  const prisma = new PrismaClient();
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("appends an event at the next version with an outbox row (envelope payload)", async () => {
    const orderId = randomUUID();
    // seed v1
    const v1 = await appendEvent(prisma, {
      tenantId: "berlin", aggregateType: "ORDER", aggregateId: orderId,
      eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId, customerId: "c", items: [], totalAmount: 1 },
    });
    expect(v1.version).toBe(1);

    const v2 = await appendEvent(prisma, {
      tenantId: "berlin", aggregateType: "ORDER", aggregateId: orderId,
      eventType: EVENT_TYPES.ORDER_ACCEPTED, payload: { orderId },
    });
    expect(v2.version).toBe(2);
    expect(v2.eventType).toBe("OrderAccepted");

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.version)).toEqual([1, 2]);

    const outbox = await prisma.outbox.findUnique({ where: { id: v2.eventId } });
    expect(outbox?.partitionKey).toBe(`berlin:${orderId}`);
    expect((outbox?.payload as { eventId: string }).eventId).toBe(v2.eventId); // outbox stores the full envelope

    // cleanup
    await prisma.outbox.deleteMany({ where: { tenantId: "berlin", partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { tenantId: "berlin", aggregateId: orderId } });
  });
});
```

- [ ] **Step 3: Run -> FAIL**

Run: `pnpm test -- packages/shared/src/event-store.spec.ts`
Expected: FAIL (`appendEvent` not exported).

- [ ] **Step 4: Implement appendEvent + connectTemporal**

Create `packages/shared/src/event-store.ts`:
```ts
import { PrismaClient, Prisma } from "@prisma/client";
import { buildEnvelope, TOPICS, type EventEnvelope } from "@flashbite/contracts";

type Tx = Prisma.TransactionClient | PrismaClient;

export interface AppendEventArgs {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

/**
 * Appends a domain event to the event store + outbox atomically, at the next
 * version for the aggregate. event_store.payload = domain payload; outbox.payload
 * = the full envelope (so the poller publishes the envelope). Returns the envelope.
 */
export async function appendEvent(prisma: PrismaClient, args: AppendEventArgs): Promise<EventEnvelope> {
  return prisma.$transaction(async (tx: Tx) => {
    const last = await tx.eventStore.findFirst({
      where: { tenantId: args.tenantId, aggregateId: args.aggregateId },
      orderBy: { version: "desc" },
    });
    const version = (last?.version ?? 0) + 1;
    const envelope = buildEnvelope({
      tenantId: args.tenantId,
      eventType: args.eventType,
      version,
      payload: args.payload,
    });
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
}
```

Create `packages/shared/src/temporal.ts`:
```ts
import { Client, Connection } from "@temporalio/client";
import { loadConfig } from "./config";

export interface TemporalHandle {
  connection: Connection;
  client: Client;
}

export async function connectTemporal(address: string = loadConfig().temporalAddress): Promise<TemporalHandle> {
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace: "default" });
  return { connection, client };
}
```

Append to `packages/shared/src/index.ts`:
```ts
export * from "./event-store";
export * from "./temporal";
```

- [ ] **Step 5: Write the connectTemporal test**

Create `packages/shared/src/temporal.spec.ts`:
```ts
import { connectTemporal } from "@flashbite/shared";

describe("connectTemporal", () => {
  it("connects to the Temporal frontend", async () => {
    const { connection, client } = await connectTemporal();
    expect(client).toBeDefined();
    // a lightweight gRPC call to confirm the frontend is reachable
    await connection.workflowService.getSystemInfo({});
    await connection.close();
  });
});
```

- [ ] **Step 6: Run -> PASS**

Run: `pnpm install && pnpm test -- packages/shared/src/event-store.spec.ts packages/shared/src/temporal.spec.ts`
Expected: PASS — appendEvent versions to 2 with envelope outbox row; connectTemporal reaches the frontend.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/package.json packages/shared/src/event-store.ts packages/shared/src/temporal.ts packages/shared/src/event-store.spec.ts packages/shared/src/temporal.spec.ts packages/shared/src/index.ts pnpm-lock.yaml
git commit -m "feat(shared): appendEvent (event store + outbox) and connectTemporal helpers"
```
End commit body with the `Co-Authored-By` line.

---

## Task 4: saga-worker — activities

**Files:**
- Create: `apps/saga-worker/package.json`, `apps/saga-worker/tsconfig.json`
- Create: `apps/saga-worker/src/activities.ts`
- Create: `apps/saga-worker/test/activities.spec.ts`

- [ ] **Step 1: Create the package + tsconfig**

Create `apps/saga-worker/package.json`:
```json
{
  "name": "@flashbite/saga-worker",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "start": "node -r @swc-node/register -r tsconfig-paths/register src/main.ts"
  },
  "dependencies": {
    "@flashbite/contracts": "workspace:*",
    "@flashbite/shared": "workspace:*",
    "@prisma/client": "5.18.0",
    "@temporalio/activity": "1.11.1",
    "@temporalio/client": "1.11.1",
    "@temporalio/worker": "1.11.1",
    "@temporalio/workflow": "1.11.1",
    "kafkajs": "2.2.4"
  },
  "devDependencies": {
    "@temporalio/testing": "1.11.1"
  }
}
```

Create `apps/saga-worker/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node"
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 2: Write the failing activities test**

Create `apps/saga-worker/test/activities.spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { appendEvent } from "@flashbite/shared";
import { EVENT_TYPES } from "@flashbite/contracts";
import { createActivities } from "../src/activities";

describe("saga activities", () => {
  const prisma = new PrismaClient();
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("recordOrderAccepted appends an OrderAccepted event at the next version", async () => {
    const orderId = randomUUID();
    await appendEvent(prisma, { tenantId: "berlin", aggregateType: "ORDER", aggregateId: orderId, eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId } }); // v1
    const activities = createActivities(prisma);
    await activities.recordOrderAcceptedActivity("berlin", orderId);

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["OrderPlaced", "OrderAccepted"]);
    expect(events[1].version).toBe(2);

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  });

  it("charge + refund activities resolve without throwing (fake gateway)", async () => {
    const activities = createActivities(prisma);
    await expect(activities.chargePaymentActivity("berlin", "o", 100)).resolves.toBeUndefined();
    await expect(activities.refundPaymentActivity("berlin", "o", 100)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run -> FAIL**

Run: `pnpm install && pnpm test -- apps/saga-worker/test/activities.spec.ts`
Expected: FAIL (`createActivities` not found).

- [ ] **Step 4: Implement activities (factory taking a Prisma client)**

Create `apps/saga-worker/src/activities.ts`:
```ts
import type { PrismaClient } from "@prisma/client";
import { appendEvent } from "@flashbite/shared";
import { EVENT_TYPES } from "@flashbite/contracts";

/**
 * Activities are created with a Prisma client so they can append events. The
 * record-* activities own the event-type strings, keeping the workflow free of
 * any contracts import (workflow-bundle determinism).
 */
export function createActivities(prisma: PrismaClient) {
  return {
    async chargePaymentActivity(tenantId: string, orderId: string, amount: number): Promise<void> {
      // Fake payment gateway. Phase 3 swaps in a real provider.
      // eslint-disable-next-line no-console
      console.log(`[charge] tenant=${tenantId} order=${orderId} amount=${amount}`);
    },
    async refundPaymentActivity(tenantId: string, orderId: string, amount: number): Promise<void> {
      // eslint-disable-next-line no-console
      console.log(`[refund] tenant=${tenantId} order=${orderId} amount=${amount}`);
    },
    async recordOrderAcceptedActivity(tenantId: string, orderId: string): Promise<void> {
      await appendEvent(prisma, {
        tenantId, aggregateType: "ORDER", aggregateId: orderId,
        eventType: EVENT_TYPES.ORDER_ACCEPTED, payload: { orderId },
      });
    },
    async recordOrderCancelledActivity(tenantId: string, orderId: string, reason: string): Promise<void> {
      await appendEvent(prisma, {
        tenantId, aggregateType: "ORDER", aggregateId: orderId,
        eventType: EVENT_TYPES.ORDER_CANCELLED, payload: { orderId, reason },
      });
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
```

- [ ] **Step 5: Run -> PASS**

Run: `pnpm test -- apps/saga-worker/test/activities.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/saga-worker pnpm-lock.yaml
git commit -m "feat(saga-worker): activities (fake charge/refund + record accepted/cancelled)"
```
End commit body with the `Co-Authored-By` line.

---

## Task 5: saga-worker — the order-lifecycle workflow

**Files:**
- Create: `apps/saga-worker/src/workflows.ts`
- Create: `apps/saga-worker/test/workflow.spec.ts`

- [ ] **Step 1: Write the failing workflow test (time-skipping env)**

Create `apps/saga-worker/test/workflow.spec.ts`:
```ts
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import path from "node:path";
import { orderLifecycleWorkflow, merchantApprovalSignal } from "../src/workflows";

describe("orderLifecycleWorkflow", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });
  afterAll(async () => {
    await env?.teardown();
  });

  const calls: string[] = [];
  const stubActivities = {
    async chargePaymentActivity() { calls.push("charge"); },
    async refundPaymentActivity() { calls.push("refund"); },
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

  it("ACCEPTED when the approval signal arrives before the SLA", async () => {
    calls.length = 0;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:accept-${Date.now()}`,
        args: [{ tenantId: "berlin", orderId: "o1", totalAmount: 1200, slaSeconds: 300 }],
      });
      await handle.signal(merchantApprovalSignal, true);
      return handle.result();
    });
    expect(result).toBe("ACCEPTED");
    expect(calls).toEqual(["charge", "accepted"]);
  });

  it("CANCELLED_SLA when no signal arrives before the SLA (time-skipped)", async () => {
    calls.length = 0;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:breach-${Date.now()}`,
        args: [{ tenantId: "berlin", orderId: "o2", totalAmount: 1200, slaSeconds: 300 }],
      });
      return handle.result(); // time-skipping advances past the 300s SLA instantly
    });
    expect(result).toBe("CANCELLED_SLA");
    expect(calls).toEqual(["charge", "refund", "cancelled:SLA_BREACH"]);
  });

  it("CANCELLED_DECLINED when the merchant declines", async () => {
    calls.length = 0;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:decline-${Date.now()}`,
        args: [{ tenantId: "berlin", orderId: "o3", totalAmount: 1200, slaSeconds: 300 }],
      });
      await handle.signal(merchantApprovalSignal, false);
      return handle.result();
    });
    expect(result).toBe("CANCELLED_DECLINED");
    expect(calls).toEqual(["charge", "refund", "cancelled:DECLINED"]);
  });
});
```

- [ ] **Step 2: Run -> FAIL**

Run: `pnpm test -- apps/saga-worker/test/workflow.spec.ts`
Expected: FAIL (`../src/workflows` missing). (First run also downloads the Temporal test server binary — allow time.)

- [ ] **Step 3: Implement the workflow**

Create `apps/saga-worker/src/workflows.ts`:
```ts
import { proxyActivities, condition, defineSignal, setHandler } from "@temporalio/workflow";
import type { Activities } from "./activities";

export const merchantApprovalSignal = defineSignal<[boolean]>("merchantApproval");

const { chargePaymentActivity, refundPaymentActivity, recordOrderAcceptedActivity, recordOrderCancelledActivity } =
  proxyActivities<Activities>({ startToCloseTimeout: "1 minute" });

export interface OrderLifecycleArgs {
  tenantId: string;
  orderId: string;
  totalAmount: number;
  slaSeconds: number;
}

/**
 * Charge -> race the SLA timer against the merchant-approval signal.
 * Approved in time -> OrderAccepted. Declined or SLA breach -> refund + OrderCancelled.
 * Deterministic: all I/O is in activities; no contracts/node imports here.
 */
export async function orderLifecycleWorkflow(args: OrderLifecycleArgs): Promise<string> {
  let approved: boolean | undefined;
  setHandler(merchantApprovalSignal, (value) => { approved = value; });

  await chargePaymentActivity(args.tenantId, args.orderId, args.totalAmount);

  const signalledInTime = await condition(() => approved !== undefined, `${args.slaSeconds}s`);

  if (signalledInTime && approved) {
    await recordOrderAcceptedActivity(args.tenantId, args.orderId);
    return "ACCEPTED";
  }

  await refundPaymentActivity(args.tenantId, args.orderId, args.totalAmount);
  const reason = signalledInTime ? "DECLINED" : "SLA_BREACH";
  await recordOrderCancelledActivity(args.tenantId, args.orderId, reason);
  return reason === "SLA_BREACH" ? "CANCELLED_SLA" : "CANCELLED_DECLINED";
}
```

- [ ] **Step 4: Run -> PASS**

Run: `pnpm test -- apps/saga-worker/test/workflow.spec.ts`
Expected: PASS (3 tests: accept, SLA breach, decline). The SLA-breach test completes instantly via time-skipping.

- [ ] **Step 5: Commit**

```bash
git add apps/saga-worker/src/workflows.ts apps/saga-worker/test/workflow.spec.ts
git commit -m "feat(saga-worker): order-lifecycle workflow (SLA timer vs approval signal)"
```
End commit body with the `Co-Authored-By` line.

---

## Task 6: saga-worker — main (Temporal worker + Kafka starter)

**Files:**
- Create: `apps/saga-worker/src/main.ts`
- Create: `apps/saga-worker/test/saga.e2e-spec.ts`

- [ ] **Step 1: Write the failing integration test (live Temporal + Kafka + Postgres)**

Create `apps/saga-worker/test/saga.e2e-spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, TemporalHandle } from "@flashbite/shared";
import { merchantApprovalSignal } from "../src/workflows";
import { startSagaWorker, SagaWorkerHandle } from "../src/main";

describe("saga-worker (e2e: live Temporal + Postgres)", () => {
  const prisma = new PrismaClient();
  let temporal: TemporalHandle;
  let saga: SagaWorkerHandle;

  beforeAll(async () => {
    await prisma.$connect();
    temporal = await connectTemporal();
    saga = await startSagaWorker(); // boots Temporal worker + (we drive workflows directly here)
  }, 60000);
  afterAll(async () => {
    await saga?.stop();
    await temporal?.connection.close();
    await prisma.$disconnect();
  });

  it("approved order writes an OrderAccepted event (v2) to the store/outbox", async () => {
    const orderId = randomUUID();
    // seed v1 OrderPlaced so appendEvent in the activity lands at v2
    const { appendEvent } = await import("@flashbite/shared");
    const { EVENT_TYPES } = await import("@flashbite/contracts");
    await appendEvent(prisma, { tenantId: "berlin", aggregateType: "ORDER", aggregateId: orderId, eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId } });

    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 60 }],
    });
    await handle.signal(merchantApprovalSignal, true);
    const result = await handle.result();
    expect(result).toBe("ACCEPTED");

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["OrderPlaced", "OrderAccepted"]);

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);
});
```

- [ ] **Step 2: Run -> FAIL**

Run: `pnpm test -- apps/saga-worker/test/saga.e2e-spec.ts`
Expected: FAIL (`startSagaWorker`/`SagaWorkerHandle` not exported).

- [ ] **Step 3: Implement main (worker + kafka starter)**

Create `apps/saga-worker/src/main.ts`:
```ts
import path from "node:path";
import { Worker, NativeConnection } from "@temporalio/worker";
import { WorkflowIdReusePolicy } from "@temporalio/client";
import { Kafka, logLevel, type Consumer } from "kafkajs";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, loadConfig, type TemporalHandle } from "@flashbite/shared";
import { EVENT_TYPES, type EventEnvelope, type OrderPlacedPayload } from "@flashbite/contracts";
import { createActivities } from "./activities";

const TASK_QUEUE = "order-lifecycle";

export interface SagaWorkerHandle {
  stop: () => Promise<void>;
}

/** Boots the Temporal worker (workflows + activities). Returns a stop handle. */
export async function startSagaWorker(): Promise<SagaWorkerHandle> {
  const config = loadConfig();
  const prisma = new PrismaClient();
  await prisma.$connect();

  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    workflowsPath: path.join(__dirname, "workflows.ts"),
    activities: createActivities(prisma),
  });
  const runPromise = worker.run();

  return {
    stop: async () => {
      worker.shutdown();
      await runPromise.catch(() => undefined);
      await connection.close();
      await prisma.$disconnect();
    },
  };
}

/** Kafka consumer: start one workflow per OrderPlaced. Returns a stop handle. */
export async function startOrderConsumer(consumer: Consumer, temporal: TemporalHandle, slaSeconds: number): Promise<SagaWorkerHandle> {
  await consumer.connect();
  await consumer.subscribe({ topic: EVENT_TYPES ? "order-events" : "order-events", fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const envelope = JSON.parse(message.value.toString()) as EventEnvelope;
      if (envelope.eventType !== EVENT_TYPES.ORDER_PLACED) return;
      const p = envelope.payload as OrderPlacedPayload;
      try {
        await temporal.client.workflow.start("orderLifecycleWorkflow", {
          taskQueue: TASK_QUEUE,
          workflowId: `${envelope.tenantId}:${p.orderId}`,
          workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
          args: [{ tenantId: envelope.tenantId, orderId: p.orderId, totalAmount: p.totalAmount, slaSeconds }],
        });
      } catch (err) {
        // duplicate start (re-delivered OrderPlaced) is expected and safe to ignore
        if (!/already started|WorkflowExecutionAlreadyStarted/i.test(String(err))) throw err;
      }
    },
  });
  return { stop: async () => { await consumer.disconnect(); } };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const saga = await startSagaWorker();
  const temporal = await connectTemporal();
  const kafka = new Kafka({ clientId: "saga-worker", brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
  const consumer = kafka.consumer({ groupId: "saga-worker" });
  const orderConsumer = await startOrderConsumer(consumer, temporal, config.sagaSlaSeconds);

  // eslint-disable-next-line no-console
  console.log("saga-worker running");
  const shutdown = async (): Promise<void> => {
    await orderConsumer.stop();
    await temporal.connection.close();
    await saga.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
```
Note: the `EVENT_TYPES ? "order-events" : "order-events"` is a guard-free constant; use the import `TOPICS.ORDER_EVENTS` instead — replace that subscribe line with `await consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });` and add `TOPICS` to the contracts import. (This keeps the topic name from the shared constant.)

- [ ] **Step 4: Fix the topic import**

In `apps/saga-worker/src/main.ts`, change the contracts import to include `TOPICS` and use `TOPICS.ORDER_EVENTS` in the subscribe call:
```ts
import { EVENT_TYPES, TOPICS, type EventEnvelope, type OrderPlacedPayload } from "@flashbite/contracts";
```
```ts
await consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });
```

- [ ] **Step 5: Run -> PASS**

Run: `pnpm test -- apps/saga-worker/test/saga.e2e-spec.ts`
Expected: PASS — the worker executes the workflow; signalling accept produces an `OrderAccepted` v2 event. (First run bundles the workflow + connects to Temporal — allow up to ~60s.)

- [ ] **Step 6: Commit**

```bash
git add apps/saga-worker/src/main.ts apps/saga-worker/test/saga.e2e-spec.ts
git commit -m "feat(saga-worker): temporal worker + kafka starter (OrderPlaced -> workflow)"
```
End commit body with the `Co-Authored-By` line.

---

## Task 7: write-api — merchant accept endpoint (signals the workflow)

**Files:**
- Modify: `apps/write-api/package.json` (add `@temporalio/client`)
- Create: `apps/write-api/src/temporal/temporal.service.ts`
- Create: `apps/write-api/src/orders/accept.controller.ts`
- Modify: `apps/write-api/src/orders/orders.module.ts`
- Create: `apps/write-api/test/accept.e2e-spec.ts`

- [ ] **Step 1: Add the Temporal client dependency**

In `apps/write-api/package.json` dependencies add (keep existing):
```json
    "@temporalio/client": "1.11.1"
```
Then `pnpm install`.

- [ ] **Step 2: Write the failing e2e (boots saga worker, places+accepts, asserts ACCEPTED)**

Create `apps/write-api/test/accept.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, appendEvent, TemporalHandle } from "@flashbite/shared";
import { startSagaWorker, SagaWorkerHandle } from "../../saga-worker/src/main";
import { AppModule } from "../src/app.module";

describe("write-api merchant accept (e2e)", () => {
  let app: INestApplication;
  let saga: SagaWorkerHandle;
  let temporal: TemporalHandle;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.$connect();
    saga = await startSagaWorker();
    temporal = await connectTemporal();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await saga?.stop();
    await temporal?.connection.close();
    await prisma.$disconnect();
  });

  it("POST /orders/:id/accept signals the workflow -> ACCEPTED + OrderAccepted event", async () => {
    const orderId = randomUUID();
    await appendEvent(prisma, { tenantId: "berlin", aggregateType: "ORDER", aggregateId: orderId, eventType: "OrderPlaced", payload: { orderId } });
    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 60 }],
    });

    const res = await request(app.getHttpServer()).post(`/orders/${orderId}/accept`).set("X-Tenant-ID", "berlin");
    expect(res.status).toBe(202);

    const result = await handle.result();
    expect(result).toBe("ACCEPTED");

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);
});
```

- [ ] **Step 3: Run -> FAIL**

Run: `pnpm install && pnpm test -- apps/write-api/test/accept.e2e-spec.ts`
Expected: FAIL — `POST /orders/:id/accept` 404 (route missing).

- [ ] **Step 4: Implement TemporalService**

Create `apps/write-api/src/temporal/temporal.service.ts`:
```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Client, Connection } from "@temporalio/client";
import { loadConfig } from "@flashbite/shared";

@Injectable()
export class TemporalService implements OnModuleInit, OnModuleDestroy {
  private connection!: Connection;
  client!: Client;

  async onModuleInit(): Promise<void> {
    this.connection = await Connection.connect({ address: loadConfig().temporalAddress });
    this.client = new Client({ connection: this.connection, namespace: "default" });
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }
}
```

- [ ] **Step 5: Implement the accept controller**

Create `apps/write-api/src/orders/accept.controller.ts`:
```ts
import { Controller, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { getTenantId } from "@flashbite/tenant-context";
import { TemporalService } from "../temporal/temporal.service";

const MERCHANT_APPROVAL_SIGNAL = "merchantApproval";

@Controller("orders")
export class AcceptController {
  constructor(private readonly temporal: TemporalService) {}

  @Post(":orderId/accept")
  @HttpCode(202)
  async accept(@Param("orderId") orderId: string): Promise<{ orderId: string; signalled: string }> {
    return this.signal(orderId, true);
  }

  @Post(":orderId/decline")
  @HttpCode(202)
  async decline(@Param("orderId") orderId: string): Promise<{ orderId: string; signalled: string }> {
    return this.signal(orderId, false);
  }

  private async signal(orderId: string, approved: boolean): Promise<{ orderId: string; signalled: string }> {
    const tenantId = getTenantId();
    const handle = this.temporal.client.workflow.getHandle(`${tenantId}:${orderId}`);
    try {
      await handle.signal(MERCHANT_APPROVAL_SIGNAL, approved);
    } catch (err) {
      if (/not found|NotFound/i.test(String(err))) {
        throw new NotFoundException(`No active order workflow for ${orderId}`);
      }
      throw err;
    }
    return { orderId, signalled: approved ? "accept" : "decline" };
  }
}
```

- [ ] **Step 6: Wire into OrdersModule**

In `apps/write-api/src/orders/orders.module.ts`, add `TemporalService` to providers and `AcceptController` to controllers (keep the existing `OrdersController`, `OrdersService`, `PrismaService`):
```ts
import { Module } from "@nestjs/common";
import { PrismaService } from "@flashbite/shared";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { AcceptController } from "./accept.controller";
import { TemporalService } from "../temporal/temporal.service";

@Module({
  controllers: [OrdersController, AcceptController],
  providers: [OrdersService, PrismaService, TemporalService],
})
export class OrdersModule {}
```

- [ ] **Step 7: Run -> PASS**

Run: `pnpm test -- apps/write-api/test/accept.e2e-spec.ts`
Expected: PASS — the endpoint signals the running workflow; result `ACCEPTED`; `OrderAccepted` appended.

- [ ] **Step 8: Commit**

```bash
git add apps/write-api/package.json apps/write-api/src/temporal apps/write-api/src/orders/accept.controller.ts apps/write-api/src/orders/orders.module.ts apps/write-api/test/accept.e2e-spec.ts pnpm-lock.yaml
git commit -m "feat(write-api): merchant accept/decline endpoint signals the saga workflow"
```
End commit body with the `Co-Authored-By` line.

---

## Task 8: e2e (SLA breach), CI (Temporal), dev scripts, verification

**Files:**
- Create: `apps/saga-worker/test/breach.e2e-spec.ts`
- Modify: `infra/docker-compose.ci.yml` (add temporal + temporal-postgres)
- Modify: `.github/workflows/test.yml` (TEMPORAL_ADDRESS env + topics ready before tests)
- Modify: root `package.json` (add `dev:saga`)
- Create: `docs/superpowers/plans/phase-1c-i-verification.md`

- [ ] **Step 1: Write the SLA-breach e2e (full pipeline, short SLA)**

Create `apps/saga-worker/test/breach.e2e-spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, appendEvent, TemporalHandle } from "@flashbite/shared";
import { EVENT_TYPES } from "@flashbite/contracts";
import { startSagaWorker, SagaWorkerHandle } from "../src/main";

describe("saga-worker SLA breach (e2e)", () => {
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

  it("no approval before the SLA -> refund + OrderCancelled(reason=SLA_BREACH)", async () => {
    const orderId = randomUUID();
    await appendEvent(prisma, { tenantId: "berlin", aggregateType: "ORDER", aggregateId: orderId, eventType: EVENT_TYPES.ORDER_PLACED, payload: { orderId } });

    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: 1200, slaSeconds: 2 }], // short real SLA
    });
    const result = await handle.result();
    expect(result).toBe("CANCELLED_SLA");

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["OrderPlaced", "OrderCancelled"]);
    const cancelled = events.find((e) => e.eventType === "OrderCancelled");
    expect((cancelled?.payload as { reason: string }).reason).toBe("SLA_BREACH");

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 30000);
});
```

- [ ] **Step 2: Run -> PASS**

Run: `pnpm test -- apps/saga-worker/test/breach.e2e-spec.ts`
Expected: PASS — after ~2s the workflow refunds and records `OrderCancelled` (reason `SLA_BREACH`).

- [ ] **Step 3: Add Temporal to the CI compose**

Append to `infra/docker-compose.ci.yml` under `services:` (keep postgres, redpanda, mongodb, redis-cluster):
```yaml
  temporal-postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: temporal
      POSTGRES_PASSWORD: temporal
      POSTGRES_DB: temporal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U temporal -d temporal"]
      interval: 5s
      timeout: 5s
      retries: 20

  temporal:
    image: temporalio/auto-setup:1.24.2
    depends_on:
      temporal-postgres:
        condition: service_healthy
    environment:
      - DB=postgres12
      - DB_PORT=5432
      - POSTGRES_SEEDS=temporal-postgres
      - POSTGRES_USER=temporal
      - POSTGRES_PWD=temporal
    ports:
      - "7233:7233"
    healthcheck:
      test: ["CMD", "tctl", "--address", "temporal:7233", "cluster", "health"]
      interval: 10s
      timeout: 5s
      retries: 20
```

- [ ] **Step 4: Add TEMPORAL_ADDRESS to the workflow**

In `.github/workflows/test.yml`, under the job-level `env:` block add (keep the others):
```yaml
      TEMPORAL_ADDRESS: localhost:7233
```
Validate: `docker compose -f infra/docker-compose.ci.yml config --quiet && echo CI_OK`.

- [ ] **Step 5: Add the dev:saga script**

In root `package.json` scripts add (keep existing):
```json
    "dev:saga": "node -r @swc-node/register -r tsconfig-paths/register --env-file=.env apps/saga-worker/src/main.ts"
```

- [ ] **Step 6: Full local suite**

Run: `pnpm test`
Expected: all suites pass (Phase 1a + 1b + 1c-i: contracts, shared event-store/temporal, projection accepted/cancelled, saga activities/workflow/e2e/breach, write-api accept). Serial + clean exit. Report totals.

- [ ] **Step 7: Manual end-to-end (happy + breach)**

With infra up, start all services in the background: `pnpm dev:write-api`, `pnpm dev:outbox`, `pnpm dev:projection`, `pnpm dev:read-api`, `pnpm dev:saga`. Then:
```bash
# Happy path: place -> saga starts -> accept -> read model ACCEPTED
ORDER_ID=$(uuidgen)
curl -s -XPOST localhost:3001/orders -H 'Content-Type: application/json' -H 'X-Tenant-ID: berlin' \
  -d "{\"orderId\":\"$ORDER_ID\",\"customerId\":\"c-1\",\"items\":[{\"sku\":\"pizza\",\"qty\":1,\"price\":1200}],\"totalAmount\":1200}"
sleep 2
curl -s -XPOST localhost:3001/orders/$ORDER_ID/accept -H 'X-Tenant-ID: berlin'
sleep 2
curl -s localhost:3002/orders/$ORDER_ID -H 'X-Tenant-ID: berlin'   # expect status ACCEPTED
```
Report the ORDER_ID + the final read-api response (status ACCEPTED). Stop all background processes (no orphans).

- [ ] **Step 8: Verification doc**

Create `docs/superpowers/plans/phase-1c-i-verification.md`:
```markdown
# Phase 1c-i — Verification

Prereq: `pnpm infra:up` (Postgres, Redpanda, MongoDB, Redis Cluster, Temporal).

## Automated
`pnpm test` — adds: shared appendEvent/connectTemporal, projection accepted/cancelled,
saga activities + workflow (time-skipping) + live e2e (accept) + breach e2e, write-api accept endpoint.

## Manual end-to-end
1. Start: dev:write-api, dev:outbox, dev:projection, dev:read-api, dev:saga.
2. POST an order -> saga-worker starts the workflow on OrderPlaced.
3. POST /orders/<id>/accept -> workflow ACCEPTED -> OrderAccepted event -> read model status ACCEPTED.
4. Or do nothing: after the SLA the workflow refunds + emits OrderCancelled -> read model CANCELLED.

Saga: charge -> race SLA vs merchant-approval signal -> accept | refund+cancel; events
flow back through the outbox -> order-events -> projection.
Phase 1c-ii adds driver telemetry (GPS -> Redis geo).
```

- [ ] **Step 9: Commit**

```bash
git add apps/saga-worker/test/breach.e2e-spec.ts infra/docker-compose.ci.yml .github/workflows/test.yml package.json docs/superpowers/plans/phase-1c-i-verification.md
git commit -m "test+ci(saga): SLA-breach e2e; add Temporal to CI; dev:saga + verification"
```
End commit body with the `Co-Authored-By` line.

---

## Self-Review (completed by plan author)

**Spec coverage (master spec §3.2 orchestration, §4 SLA saga, §3.6 idempotency):**
- Kafka → saga-worker → Temporal workflow (§3.2) → Task 6 Kafka starter + worker. ✓
- SLA timer vs merchant-approval signal; compensation refund on breach (§4) → Task 5 workflow + Task 4 activities. ✓
- Tenant-scoped `WorkflowId = tenantId:orderId` + reject-duplicate dedup (§3.6) → Task 6. ✓
- Compensation events flow back to the read model → Task 3 appendEvent + Task 2 projection. ✓
- Merchant approval as a Temporal signal, triggered from the command API → Task 7 accept endpoint. ✓

**Placeholder scan:** No TBD/TODO; every code/command step is complete. (Task 6 Step 3 intentionally writes a guard-free constant then Step 4 corrects it to `TOPICS.ORDER_EVENTS` — the final state uses the shared constant.)

**Type/name consistency:** `EVENT_TYPES.ORDER_ACCEPTED`/`ORDER_CANCELLED`, `ORDER_STATUS.ACCEPTED`/`CANCELLED`, `appendEvent(prisma, {tenantId, aggregateType, aggregateId, eventType, payload})`, `connectTemporal`/`TemporalHandle`, `createActivities(prisma)` → `chargePaymentActivity`/`refundPaymentActivity`/`recordOrderAcceptedActivity`/`recordOrderCancelledActivity`, `orderLifecycleWorkflow(args)` returning `"ACCEPTED"`/`"CANCELLED_SLA"`/`"CANCELLED_DECLINED"`, `merchantApprovalSignal` (name `"merchantApproval"`), task queue `"order-lifecycle"`, `WorkflowId = ${tenantId}:${orderId}`, accept route `POST /orders/:orderId/accept` (202) — all consistent across saga-worker, write-api, and tests. The accept controller uses the raw signal name string `"merchantApproval"` matching `defineSignal("merchantApproval")` in the workflow (it cannot import the workflow's signal object into the Nest app without pulling the workflow bundle, so the string is intentionally duplicated and asserted by the Task 7 e2e).

**Determinism check:** `workflows.ts` imports only `@temporalio/workflow` + the activity *type* — no `@flashbite/contracts` (which pulls `node:crypto`). Event-type strings live in `activities.ts`. This keeps the workflow bundle clean.

**Scope note:** Telemetry (GPS → Redis geo) is Phase 1c-ii. Frontends are Phase 1d. The accept endpoint signals an existing workflow; the Kafka starter (Task 6) is what auto-starts it in the running system, so the manual e2e (place → accept) works without the test harness starting workflows directly.
```
