# FlashBite Phase 1b — Query Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the query side of the walking skeleton — a `projection-worker` that consumes `order-events` into MongoDB read models (idempotently), and a `read-api` that serves those models with a Redis cache and a live SSE merchant feed.

**Architecture:** A plain-TS `projection-worker` (mirrors the outbox-poller) consumes Kafka, dedupes via a Mongo inbox collection, and upserts an `orders` read model with a version guard. A NestJS `read-api` queries Mongo with a Redis cache-aside layer (`{tenant:id}` hash tags) and exposes an SSE endpoint fed by its own Kafka consumer. One hardcoded tenant, JSON envelopes — same as Phase 1a.

**Tech Stack:** kafkajs, MongoDB (native `mongodb` driver), ioredis Cluster, NestJS 10 (read-api), RxJS (SSE), Jest + ts-jest, @swc-node/register runtime.

---

## Context for the implementer

Phase 1a delivered the command plane: `write-api` writes an `OrderPlaced` event + outbox row; `outbox-poller` relays the full JSON **envelope** to the `order-events` topic (key `tenantId:orderId`). This phase consumes those envelopes.

**Before starting:** `pnpm infra:up`, then confirm Postgres (5434), Redpanda (9092), **MongoDB (27017)**, and the **Redis Cluster (7100–7105)** are healthy (`pnpm infra:ps`). Every integration test here hits the live stack. Master spec: `docs/superpowers/specs/2026-06-13-flashbite-showcase-design.md` (§3.2 query plane, §3.6 idempotency/inbox, §3.4 envelope).

**Decisions locked (do not deviate without escalating):**
- **projection-worker is plain TS** (no NestJS) — a kafkajs consumer calling a pure `applyEvent(db, envelope)`. Same shape as the outbox-poller. **read-api is NestJS** (HTTP + SSE).
- **Inbox lives in Mongo** (a `processed_events` collection in the read DB), keyed by `${tenantId}:${consumer}:${eventId}`. The read side does not touch the write Postgres. (The Postgres `processed_events` table from 1a stays for any future write-side consumer.)
- **Read model `_id` = `${tenantId}:${orderId}`** in the `orders` collection — tenant-scoped key.
- **Idempotency:** inbox check → idempotent upsert with a version guard (`only write if existing.version < envelope.version`) → record inbox. At-least-once safe.
- **Redis cache-aside** in read-api: key `{tenant:${tenantId}}:order:${orderId}:view`, 10s TTL. The `{...}` hash tag co-locates a tenant's keys (proven in Phase 0 Spike D).
- **Runtime:** apps run via `@swc-node/register` (emits decorator metadata → idiomatic NestJS DI, no `@Inject`).
- **Envelopes are JSON** (Avro is Phase 3).

**Conventions:** commit after every task (Conventional Commits); UUIDs from `node:crypto`; tests are `*.spec.ts`/`*.e2e-spec.ts` (run by root `jest.config.cjs`, which loads `.env` via `jest.setup.cjs`).

---

## File Structure

```
flashbite/
  packages/
    contracts/src/index.ts          # MODIFY: add OrderView, READ_COLLECTIONS, ORDER_STATUS
    shared/
      package.json                  # MODIFY: add mongodb, ioredis deps
      src/config.ts                 # MODIFY: add mongoUri, redisClusterNodes
      src/mongo.ts                  # CREATE: connectMongo() helper
      src/mongo.service.ts          # CREATE: NestJS MongoService
      src/redis.ts                  # CREATE: createRedisCluster() helper
      src/redis.service.ts          # CREATE: NestJS RedisService
      src/index.ts                  # MODIFY: re-export new modules
      src/config.spec.ts            # MODIFY: assert new config fields
      src/mongo.spec.ts             # CREATE
      src/redis.spec.ts             # CREATE
  apps/
    projection-worker/
      package.json                  # CREATE
      tsconfig.json                 # CREATE
      src/projection.ts             # CREATE: applyEvent()
      src/main.ts                   # CREATE: kafka consumer loop
      test/projection.spec.ts       # CREATE
      test/consumer.spec.ts         # CREATE (integration)
    read-api/
      package.json                  # CREATE
      tsconfig.json                 # CREATE
      src/main.ts                   # CREATE
      src/app.module.ts             # CREATE
      src/health.controller.ts      # CREATE
      src/orders/orders-query.service.ts   # CREATE
      src/orders/orders-query.controller.ts# CREATE
      src/orders/orders.module.ts          # CREATE
      src/sse/order-stream.service.ts       # CREATE
      src/sse/sse-feeder.service.ts         # CREATE (kafka -> stream)
      src/sse/merchant-sse.controller.ts    # CREATE
      src/sse/sse.module.ts                 # CREATE
      test/health.e2e-spec.ts       # CREATE
      test/orders-query.e2e-spec.ts # CREATE
      test/order-stream.spec.ts     # CREATE
      test/sse.e2e-spec.ts          # CREATE
  infra/docker-compose.ci.yml       # MODIFY (Task 8): add mongodb + redis-cluster
  .github/workflows/test.yml        # MODIFY (Task 8): add MONGO_URI + REDIS_CLUSTER_NODES env
  package.json                      # MODIFY (Task 8): dev:read-api, dev:projection scripts
```

---

## Task 1: Extend contracts + shared config with read-model + Mongo/Redis settings

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/shared/src/config.ts`, `packages/shared/src/config.spec.ts`

- [ ] **Step 1: Write the failing config test**

Replace `packages/shared/src/config.spec.ts`:
```ts
import { loadConfig } from "@flashbite/shared";

describe("loadConfig", () => {
  it("reads all settings from env with defaults", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5434/db",
      KAFKA_BROKERS: "localhost:9092",
      MONGO_URI: "mongodb://localhost:27017/flashbite_read",
      REDIS_CLUSTER_NODES: "127.0.0.1:7100,127.0.0.1:7101",
    });
    expect(cfg.databaseUrl).toBe("postgresql://u:p@localhost:5434/db");
    expect(cfg.kafkaBrokers).toEqual(["localhost:9092"]);
    expect(cfg.defaultTenantId).toBe("berlin");
    expect(cfg.mongoUri).toBe("mongodb://localhost:27017/flashbite_read");
    expect(cfg.redisClusterNodes).toEqual([
      { host: "127.0.0.1", port: 7100 },
      { host: "127.0.0.1", port: 7101 },
    ]);
  });

  it("defaults mongo + redis when unset", () => {
    const cfg = loadConfig({ DATABASE_URL: "x" });
    expect(cfg.mongoUri).toBe("mongodb://localhost:27017/flashbite_read");
    expect(cfg.redisClusterNodes).toHaveLength(6);
    expect(cfg.redisClusterNodes[0]).toEqual({ host: "127.0.0.1", port: 7100 });
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- packages/shared/src/config.spec.ts`
Expected: FAIL — `mongoUri`/`redisClusterNodes` undefined.

- [ ] **Step 3: Extend the config**

Replace `packages/shared/src/config.ts`:
```ts
export interface RedisNode {
  host: string;
  port: number;
}

export interface AppConfig {
  databaseUrl: string;
  kafkaBrokers: string[];
  defaultTenantId: string;
  mongoUri: string;
  redisClusterNodes: RedisNode[];
}

export const DEFAULT_TENANT_ID = "berlin";

const DEFAULT_REDIS_NODES = "127.0.0.1:7100,127.0.0.1:7101,127.0.0.1:7102,127.0.0.1:7103,127.0.0.1:7104,127.0.0.1:7105";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const redisClusterNodes = (env.REDIS_CLUSTER_NODES ?? DEFAULT_REDIS_NODES)
    .split(",")
    .map((hp) => {
      const [host, port] = hp.split(":");
      return { host, port: Number(port) };
    });
  return {
    databaseUrl,
    kafkaBrokers: (env.KAFKA_BROKERS ?? "localhost:9092").split(","),
    defaultTenantId: env.DEFAULT_TENANT_ID ?? DEFAULT_TENANT_ID,
    mongoUri: env.MONGO_URI ?? "mongodb://localhost:27017/flashbite_read",
    redisClusterNodes,
  };
}
```

- [ ] **Step 4: Add read-model contracts**

Append to `packages/contracts/src/index.ts` (keep all existing exports):
```ts
export interface OrderView {
  tenantId: string;
  orderId: string;
  customerId: string;
  items: OrderItem[];
  totalAmount: number;
  status: string;
  version: number;
  updatedAt: string;
}

export const ORDER_STATUS = {
  PLACED: "PLACED",
} as const;

export const READ_COLLECTIONS = {
  ORDERS: "orders",
  PROCESSED: "processed_events",
} as const;
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- packages/shared/src/config.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/shared/src/config.ts packages/shared/src/config.spec.ts
git commit -m "feat(shared): config for mongo+redis; contracts for order read model"
```
End commit body with:
```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 2: Mongo client (helper + NestJS service)

**Files:**
- Modify: `packages/shared/package.json` (add `mongodb`)
- Create: `packages/shared/src/mongo.ts`, `packages/shared/src/mongo.service.ts`, `packages/shared/src/mongo.spec.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add the mongodb dependency**

Edit `packages/shared/package.json` dependencies to add `mongodb` (keep existing):
```json
    "@prisma/client": "5.18.0",
    "@nestjs/common": "10.4.4",
    "mongodb": "6.8.0"
```
Then `pnpm install`.

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/mongo.spec.ts`:
```ts
import { connectMongo } from "@flashbite/shared";

describe("connectMongo", () => {
  it("connects and returns a usable db (ping)", async () => {
    const { client, db } = await connectMongo();
    const res = await db.command({ ping: 1 });
    expect(res.ok).toBe(1);
    await client.close();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test -- packages/shared/src/mongo.spec.ts`
Expected: FAIL — `connectMongo` not exported.

- [ ] **Step 4: Implement the helper + service**

Create `packages/shared/src/mongo.ts`:
```ts
import { MongoClient, Db } from "mongodb";
import { loadConfig } from "./config";

export interface MongoHandle {
  client: MongoClient;
  db: Db;
}

export async function connectMongo(uri: string = loadConfig().mongoUri): Promise<MongoHandle> {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db() };
}
```

Create `packages/shared/src/mongo.service.ts`:
```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { MongoClient, Db } from "mongodb";
import { connectMongo } from "./mongo";

@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  private client!: MongoClient;
  db!: Db;

  async onModuleInit(): Promise<void> {
    const handle = await connectMongo();
    this.client = handle.client;
    this.db = handle.db;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }
}
```

Append to `packages/shared/src/index.ts`:
```ts
export * from "./mongo";
export * from "./mongo.service";
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- packages/shared/src/mongo.spec.ts`
Expected: PASS (ping returns ok:1).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/package.json packages/shared/src/mongo.ts packages/shared/src/mongo.service.ts packages/shared/src/mongo.spec.ts packages/shared/src/index.ts pnpm-lock.yaml
git commit -m "feat(shared): mongodb client helper + NestJS MongoService"
```
End commit body with the `Co-Authored-By` line.

---

## Task 3: Redis Cluster client (helper + NestJS service)

**Files:**
- Modify: `packages/shared/package.json` (add `ioredis`)
- Create: `packages/shared/src/redis.ts`, `packages/shared/src/redis.service.ts`, `packages/shared/src/redis.spec.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add the ioredis dependency**

Edit `packages/shared/package.json` dependencies to add `ioredis` (keep existing):
```json
    "mongodb": "6.8.0",
    "ioredis": "5.4.1"
```
Then `pnpm install`.

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/redis.spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { createRedisCluster } from "@flashbite/shared";

describe("createRedisCluster", () => {
  it("connects to the cluster and round-trips a hash-tagged key", async () => {
    const cluster = createRedisCluster();
    const info = await cluster.cluster("INFO");
    expect(String(info)).toContain("cluster_state:ok");

    const key = `{tenant:berlin}:probe:${randomUUID()}`;
    await cluster.set(key, "v1", "EX", 10);
    const back = await cluster.get(key);
    expect(back).toBe("v1");

    await cluster.quit();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test -- packages/shared/src/redis.spec.ts`
Expected: FAIL — `createRedisCluster` not exported.

- [ ] **Step 4: Implement the helper + service**

Create `packages/shared/src/redis.ts`:
```ts
import { Cluster } from "ioredis";
import { loadConfig, RedisNode } from "./config";

/**
 * The local grokzen cluster announces nodes as 0.0.0.0:<port>; map those to
 * 127.0.0.1 so a host client follows MOVED redirects (proven in Phase 0 Spike D).
 */
export function createRedisCluster(nodes: RedisNode[] = loadConfig().redisClusterNodes): Cluster {
  const natMap = Object.fromEntries(
    nodes.map((n) => [`0.0.0.0:${n.port}`, { host: "127.0.0.1", port: n.port }]),
  );
  return new Cluster(nodes, { natMap });
}
```

Create `packages/shared/src/redis.service.ts`:
```ts
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Cluster } from "ioredis";
import { createRedisCluster } from "./redis";

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly cluster: Cluster = createRedisCluster();

  async onModuleDestroy(): Promise<void> {
    await this.cluster.quit();
  }
}
```

Append to `packages/shared/src/index.ts`:
```ts
export * from "./redis";
export * from "./redis.service";
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- packages/shared/src/redis.spec.ts`
Expected: PASS (cluster_state:ok + round-trip).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/package.json packages/shared/src/redis.ts packages/shared/src/redis.service.ts packages/shared/src/redis.spec.ts packages/shared/src/index.ts pnpm-lock.yaml
git commit -m "feat(shared): redis cluster client helper + NestJS RedisService"
```
End commit body with the `Co-Authored-By` line.

---

## Task 4: projection-worker — applyEvent (inbox dedup + upsert)

**Files:**
- Create: `apps/projection-worker/package.json`, `apps/projection-worker/tsconfig.json`
- Create: `apps/projection-worker/src/projection.ts`
- Create: `apps/projection-worker/test/projection.spec.ts`

- [ ] **Step 1: Create the package + tsconfig**

Create `apps/projection-worker/package.json`:
```json
{
  "name": "@flashbite/projection-worker",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "start": "node -r @swc-node/register -r tsconfig-paths/register src/main.ts"
  },
  "dependencies": {
    "@flashbite/contracts": "workspace:*",
    "@flashbite/shared": "workspace:*",
    "kafkajs": "2.2.4",
    "mongodb": "6.8.0"
  }
}
```

Create `apps/projection-worker/tsconfig.json`:
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

- [ ] **Step 2: Write the failing test**

Create `apps/projection-worker/test/projection.spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { connectMongo, MongoHandle } from "@flashbite/shared";
import {
  buildEnvelope,
  EVENT_TYPES,
  READ_COLLECTIONS,
  type OrderPlacedPayload,
} from "@flashbite/contracts";
import { applyEvent } from "../src/projection";

describe("applyEvent", () => {
  let mongo: MongoHandle;
  beforeAll(async () => {
    mongo = await connectMongo();
  });
  afterAll(async () => {
    await mongo.client.close();
  });

  const placed = (orderId: string) => {
    const payload: OrderPlacedPayload = {
      orderId,
      customerId: "c-1",
      items: [{ sku: "pizza", qty: 1, price: 1200 }],
      totalAmount: 1200,
    };
    return buildEnvelope({ tenantId: "berlin", eventType: EVENT_TYPES.ORDER_PLACED, version: 1, payload });
  };

  it("projects an OrderPlaced into the orders read model", async () => {
    const orderId = randomUUID();
    const result = await applyEvent(mongo.db, placed(orderId));
    expect(result).toBe("applied");

    const doc = await mongo.db.collection(READ_COLLECTIONS.ORDERS).findOne({ _id: `berlin:${orderId}` });
    expect(doc).toMatchObject({ tenantId: "berlin", orderId, status: "PLACED", version: 1, totalAmount: 1200 });

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteMany({ tenantId: "berlin", eventId: { $exists: true } });
  });

  it("is idempotent — the same envelope applied twice yields one doc and is skipped the 2nd time", async () => {
    const env = placed(randomUUID());
    const first = await applyEvent(mongo.db, env);
    const second = await applyEvent(mongo.db, env);
    expect(first).toBe("applied");
    expect(second).toBe("skipped");

    const count = await mongo.db.collection(READ_COLLECTIONS.ORDERS).countDocuments({ orderId: env.payload.orderId as never });
    expect(count).toBe(1);

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${(env.payload as OrderPlacedPayload).orderId}` });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteOne({ _id: `berlin:projection-worker:${env.eventId}` });
  });

  it("ignores an older version for an existing aggregate", async () => {
    const orderId = randomUUID();
    const v2 = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 2,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: 999 } as OrderPlacedPayload,
    });
    await applyEvent(mongo.db, v2);
    // a stale version-1 event for the same aggregate must not overwrite
    const v1 = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 1,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: 111 } as OrderPlacedPayload,
    });
    await applyEvent(mongo.db, v1);

    const doc = await mongo.db.collection(READ_COLLECTIONS.ORDERS).findOne({ _id: `berlin:${orderId}` });
    expect(doc?.version).toBe(2);
    expect(doc?.totalAmount).toBe(999);

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteOne({ _id: `berlin:projection-worker:${v2.eventId}` });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteOne({ _id: `berlin:projection-worker:${v1.eventId}` });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test -- apps/projection-worker/test/projection.spec.ts`
Expected: FAIL — `applyEvent` not found.

- [ ] **Step 4: Implement applyEvent**

Create `apps/projection-worker/src/projection.ts`:
```ts
import type { Db } from "mongodb";
import {
  EVENT_TYPES,
  ORDER_STATUS,
  READ_COLLECTIONS,
  type EventEnvelope,
  type OrderPlacedPayload,
} from "@flashbite/contracts";

export const CONSUMER_NAME = "projection-worker";

/**
 * Applies one event envelope to the read model. Inbox-dedup (Mongo) + idempotent
 * upsert with a version guard. At-least-once safe: re-delivery is skipped via the
 * inbox; a crash between upsert and inbox-write re-applies idempotently on replay.
 */
export async function applyEvent(db: Db, envelope: EventEnvelope): Promise<"applied" | "skipped"> {
  const inbox = db.collection(READ_COLLECTIONS.PROCESSED);
  const inboxId = `${envelope.tenantId}:${CONSUMER_NAME}:${envelope.eventId}`;

  if (await inbox.findOne({ _id: inboxId as never })) {
    return "skipped";
  }

  if (envelope.eventType === EVENT_TYPES.ORDER_PLACED) {
    const p = envelope.payload as OrderPlacedPayload;
    const _id = `${envelope.tenantId}:${p.orderId}`;
    const orders = db.collection(READ_COLLECTIONS.ORDERS);
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
  }
  // Unknown event types fall through and are still marked processed (forward-compatible).

  try {
    await inbox.insertOne({
      _id: inboxId as never,
      tenantId: envelope.tenantId,
      consumer: CONSUMER_NAME,
      eventId: envelope.eventId,
      processedAt: new Date(),
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err; // ignore duplicate-key
  }

  return "applied";
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm install && pnpm test -- apps/projection-worker/test/projection.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/projection-worker pnpm-lock.yaml
git commit -m "feat(projection-worker): applyEvent with mongo inbox dedup + versioned upsert"
```
End commit body with the `Co-Authored-By` line.

---

## Task 5: projection-worker — Kafka consumer loop

**Files:**
- Create: `apps/projection-worker/src/main.ts`
- Create: `apps/projection-worker/test/consumer.spec.ts`

- [ ] **Step 1: Write the failing integration test**

Create `apps/projection-worker/test/consumer.spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { connectMongo, MongoHandle } from "@flashbite/shared";
import {
  buildEnvelope,
  EVENT_TYPES,
  READ_COLLECTIONS,
  TOPICS,
  type OrderPlacedPayload,
} from "@flashbite/contracts";
import { runConsumer } from "../src/main";

describe("projection-worker consumer (integration)", () => {
  let mongo: MongoHandle;
  const kafka = new Kafka({ clientId: "proj-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });

  beforeAll(async () => {
    mongo = await connectMongo();
  });
  afterAll(async () => {
    await mongo.client.close();
  });

  it("consumes an OrderPlaced envelope and projects it into Mongo", async () => {
    const orderId = randomUUID();
    const payload: OrderPlacedPayload = { orderId, customerId: "c-1", items: [], totalAmount: 500 };
    const envelope = buildEnvelope({ tenantId: "berlin", eventType: EVENT_TYPES.ORDER_PLACED, version: 1, payload });

    const consumer = kafka.consumer({ groupId: `projection-worker-test-${Date.now()}` });
    const handle = await runConsumer(consumer, mongo.db);

    const producer = kafka.producer();
    await producer.connect();
    await producer.send({
      topic: TOPICS.ORDER_EVENTS,
      messages: [{ key: `berlin:${orderId}`, value: JSON.stringify(envelope) }],
    });
    await producer.disconnect();

    // poll Mongo until the projection lands (consumer is async)
    let doc = null;
    for (let i = 0; i < 50 && !doc; i++) {
      doc = await mongo.db.collection(READ_COLLECTIONS.ORDERS).findOne({ _id: `berlin:${orderId}` });
      if (!doc) await new Promise((r) => setTimeout(r, 200));
    }
    expect(doc).toMatchObject({ orderId, status: "PLACED", totalAmount: 500 });

    await handle.stop();
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` });
    await mongo.db.collection(READ_COLLECTIONS.PROCESSED).deleteOne({ _id: `berlin:projection-worker:${envelope.eventId}` });
  }, 30000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- apps/projection-worker/test/consumer.spec.ts`
Expected: FAIL — `runConsumer` not exported.

- [ ] **Step 3: Implement main + runConsumer**

Create `apps/projection-worker/src/main.ts`:
```ts
import { Kafka, logLevel, type Consumer } from "kafkajs";
import type { Db } from "mongodb";
import { connectMongo, loadConfig } from "@flashbite/shared";
import { TOPICS, type EventEnvelope } from "@flashbite/contracts";
import { applyEvent } from "./projection";

export interface ConsumerHandle {
  stop: () => Promise<void>;
}

/** Wires a kafkajs consumer to applyEvent. Returns a handle to stop it. */
export async function runConsumer(consumer: Consumer, db: Db): Promise<ConsumerHandle> {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const envelope = JSON.parse(message.value.toString()) as EventEnvelope;
      await applyEvent(db, envelope);
    },
  });
  return { stop: async () => { await consumer.disconnect(); } };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { client, db } = await connectMongo();
  const kafka = new Kafka({ clientId: "projection-worker", brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
  const consumer = kafka.consumer({ groupId: "projection-worker" });
  const handle = await runConsumer(consumer, db);

  // eslint-disable-next-line no-console
  console.log("projection-worker running");
  const shutdown = async (): Promise<void> => {
    await handle.stop();
    await client.close();
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

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- apps/projection-worker/test/consumer.spec.ts`
Expected: PASS — the produced envelope is projected into Mongo.

- [ ] **Step 5: Commit**

```bash
git add apps/projection-worker/src/main.ts apps/projection-worker/test/consumer.spec.ts
git commit -m "feat(projection-worker): kafka consumer loop wiring applyEvent"
```
End commit body with the `Co-Authored-By` line.

---

## Task 6: read-api — bootstrap, health, GET /orders/:orderId from Mongo

**Files:**
- Create: `apps/read-api/package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`
- Create: `src/main.ts`, `src/app.module.ts`, `src/health.controller.ts`
- Create: `src/orders/orders-query.service.ts`, `src/orders/orders-query.controller.ts`, `src/orders/orders.module.ts`
- Create: `test/health.e2e-spec.ts`, `test/orders-query.e2e-spec.ts`

- [ ] **Step 1: Create the app manifest + configs**

Create `apps/read-api/package.json`:
```json
{
  "name": "@flashbite/read-api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "start": "node -r @swc-node/register -r tsconfig-paths/register src/main.ts"
  },
  "dependencies": {
    "@flashbite/contracts": "workspace:*",
    "@flashbite/shared": "workspace:*",
    "@flashbite/tenant-context": "workspace:*",
    "@nestjs/common": "10.4.4",
    "@nestjs/core": "10.4.4",
    "@nestjs/platform-express": "10.4.4",
    "kafkajs": "2.2.4",
    "reflect-metadata": "0.2.2",
    "rxjs": "7.8.1"
  },
  "devDependencies": {
    "@nestjs/testing": "10.4.4",
    "supertest": "7.0.0",
    "@types/supertest": "6.0.2"
  }
}
```

Create `apps/read-api/nest-cli.json`:
```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
```

Create `apps/read-api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "target": "ES2021",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `apps/read-api/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "test", "**/*.spec.ts", "**/*.e2e-spec.ts"]
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/read-api/test/health.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("read-api health (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns ok with the resolved tenant", async () => {
    const res = await request(app.getHttpServer()).get("/health").set("X-Tenant-ID", "berlin");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", tenantId: "berlin" });
  });
});
```

Create `apps/read-api/test/orders-query.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { MongoService } from "@flashbite/shared";
import { READ_COLLECTIONS, ORDER_STATUS } from "@flashbite/contracts";

describe("read-api orders query (e2e)", () => {
  let app: INestApplication;
  let mongo: MongoService;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    mongo = app.get(MongoService);
  });
  afterAll(async () => {
    await app.close();
  });

  it("returns a seeded order view", async () => {
    const orderId = randomUUID();
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).insertOne({
      _id: `berlin:${orderId}` as never,
      tenantId: "berlin",
      orderId,
      customerId: "c-1",
      items: [{ sku: "pizza", qty: 1, price: 1200 }],
      totalAmount: 1200,
      status: ORDER_STATUS.PLACED,
      version: 1,
      updatedAt: new Date().toISOString(),
    });

    const res = await request(app.getHttpServer()).get(`/orders/${orderId}`).set("X-Tenant-ID", "berlin");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orderId, status: "PLACED", totalAmount: 1200, tenantId: "berlin" });

    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: `berlin:${orderId}` as never });
  });

  it("returns 404 for a missing order", async () => {
    const res = await request(app.getHttpServer()).get(`/orders/${randomUUID()}`).set("X-Tenant-ID", "berlin");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm install && pnpm test -- apps/read-api`
Expected: FAIL — `AppModule` does not exist.

- [ ] **Step 4: Implement the query service (Mongo only for now)**

Create `apps/read-api/src/orders/orders-query.service.ts`:
```ts
import { Injectable } from "@nestjs/common";
import { MongoService } from "@flashbite/shared";
import { getTenantId } from "@flashbite/tenant-context";
import { READ_COLLECTIONS, type OrderView } from "@flashbite/contracts";

@Injectable()
export class OrdersQueryService {
  constructor(private readonly mongo: MongoService) {}

  async getOrder(orderId: string): Promise<OrderView | null> {
    const tenantId = getTenantId();
    const doc = await this.mongo.db
      .collection(READ_COLLECTIONS.ORDERS)
      .findOne({ _id: `${tenantId}:${orderId}` as never });
    if (!doc) return null;
    return {
      tenantId: doc.tenantId,
      orderId: doc.orderId,
      customerId: doc.customerId,
      items: doc.items,
      totalAmount: doc.totalAmount,
      status: doc.status,
      version: doc.version,
      updatedAt: doc.updatedAt,
    };
  }
}
```

Create `apps/read-api/src/orders/orders-query.controller.ts`:
```ts
import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { OrdersQueryService } from "./orders-query.service";
import type { OrderView } from "@flashbite/contracts";

@Controller("orders")
export class OrdersQueryController {
  constructor(private readonly orders: OrdersQueryService) {}

  @Get(":orderId")
  async get(@Param("orderId") orderId: string): Promise<OrderView> {
    const view = await this.orders.getOrder(orderId);
    if (!view) throw new NotFoundException(`Order ${orderId} not found`);
    return view;
  }
}
```

Create `apps/read-api/src/orders/orders.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { MongoService } from "@flashbite/shared";
import { OrdersQueryController } from "./orders-query.controller";
import { OrdersQueryService } from "./orders-query.service";

@Module({
  controllers: [OrdersQueryController],
  providers: [OrdersQueryService, MongoService],
})
export class OrdersModule {}
```

Create `apps/read-api/src/health.controller.ts`:
```ts
import { Controller, Get } from "@nestjs/common";
import { getTenantId } from "@flashbite/tenant-context";

@Controller("health")
export class HealthController {
  @Get()
  check(): { status: string; tenantId: string } {
    return { status: "ok", tenantId: getTenantId() };
  }
}
```

Create `apps/read-api/src/app.module.ts`:
```ts
import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { TenantMiddleware } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";

@Module({
  imports: [OrdersModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
```

Create `apps/read-api/src/main.ts`:
```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.READ_API_PORT ?? 3002);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`read-api listening on ${port}`);
}

bootstrap();
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm test -- apps/read-api`
Expected: PASS (health + seeded order + 404).

- [ ] **Step 6: Commit**

```bash
git add apps/read-api pnpm-lock.yaml
git commit -m "feat(read-api): bootstrap, health, GET /orders/:id from mongo read model"
```
End commit body with the `Co-Authored-By` line.

---

## Task 7: read-api — Redis cache-aside on GET /orders/:orderId

**Files:**
- Modify: `apps/read-api/src/orders/orders-query.service.ts`
- Modify: `apps/read-api/src/orders/orders.module.ts` (provide RedisService)
- Create: `apps/read-api/test/orders-cache.e2e-spec.ts`

- [ ] **Step 1: Write the failing cache test**

Create `apps/read-api/test/orders-cache.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { MongoService, RedisService } from "@flashbite/shared";
import { READ_COLLECTIONS, ORDER_STATUS } from "@flashbite/contracts";

describe("read-api orders cache-aside (e2e)", () => {
  let app: INestApplication;
  let mongo: MongoService;
  let redis: RedisService;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    mongo = app.get(MongoService);
    redis = app.get(RedisService);
  });
  afterAll(async () => {
    await app.close();
  });

  it("populates the redis cache on first read and serves the cached value after", async () => {
    const orderId = randomUUID();
    const id = `berlin:${orderId}`;
    const cacheKey = `{tenant:berlin}:order:${orderId}:view`;
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).insertOne({
      _id: id as never,
      tenantId: "berlin", orderId, customerId: "c-1", items: [],
      totalAmount: 700, status: ORDER_STATUS.PLACED, version: 1, updatedAt: "t0",
    });

    // first read -> miss -> Mongo -> cache populated
    const r1 = await request(app.getHttpServer()).get(`/orders/${orderId}`).set("X-Tenant-ID", "berlin");
    expect(r1.status).toBe(200);
    expect(r1.body.totalAmount).toBe(700);
    const cached = await redis.cluster.get(cacheKey);
    expect(cached).not.toBeNull();

    // mutate Mongo; second read should still return the CACHED (stale) value within TTL
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).updateOne({ _id: id as never }, { $set: { totalAmount: 9999 } });
    const r2 = await request(app.getHttpServer()).get(`/orders/${orderId}`).set("X-Tenant-ID", "berlin");
    expect(r2.body.totalAmount).toBe(700); // served from cache, proves cache-aside

    await redis.cluster.del(cacheKey);
    await mongo.db.collection(READ_COLLECTIONS.ORDERS).deleteOne({ _id: id as never });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- apps/read-api/test/orders-cache.e2e-spec.ts`
Expected: FAIL — cache not populated (RedisService not wired / no caching).

- [ ] **Step 3: Add cache-aside to the query service**

Replace `apps/read-api/src/orders/orders-query.service.ts`:
```ts
import { Injectable } from "@nestjs/common";
import { MongoService, RedisService } from "@flashbite/shared";
import { getTenantId } from "@flashbite/tenant-context";
import { READ_COLLECTIONS, type OrderView } from "@flashbite/contracts";

const CACHE_TTL_SECONDS = 10;

@Injectable()
export class OrdersQueryService {
  constructor(
    private readonly mongo: MongoService,
    private readonly redis: RedisService,
  ) {}

  async getOrder(orderId: string): Promise<OrderView | null> {
    const tenantId = getTenantId();
    const cacheKey = `{tenant:${tenantId}}:order:${orderId}:view`;

    const cached = await this.redis.cluster.get(cacheKey);
    if (cached) return JSON.parse(cached) as OrderView;

    const doc = await this.mongo.db
      .collection(READ_COLLECTIONS.ORDERS)
      .findOne({ _id: `${tenantId}:${orderId}` as never });
    if (!doc) return null;

    const view: OrderView = {
      tenantId: doc.tenantId,
      orderId: doc.orderId,
      customerId: doc.customerId,
      items: doc.items,
      totalAmount: doc.totalAmount,
      status: doc.status,
      version: doc.version,
      updatedAt: doc.updatedAt,
    };
    await this.redis.cluster.set(cacheKey, JSON.stringify(view), "EX", CACHE_TTL_SECONDS);
    return view;
  }
}
```

- [ ] **Step 4: Provide RedisService in the module**

Replace `apps/read-api/src/orders/orders.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { MongoService, RedisService } from "@flashbite/shared";
import { OrdersQueryController } from "./orders-query.controller";
import { OrdersQueryService } from "./orders-query.service";

@Module({
  controllers: [OrdersQueryController],
  providers: [OrdersQueryService, MongoService, RedisService],
})
export class OrdersModule {}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- apps/read-api`
Expected: PASS — all read-api suites including cache-aside.

- [ ] **Step 6: Commit**

```bash
git add apps/read-api/src/orders apps/read-api/test/orders-cache.e2e-spec.ts
git commit -m "feat(read-api): redis cache-aside for order views with {tenant:id} keys"
```
End commit body with the `Co-Authored-By` line.

---

## Task 8: read-api — SSE merchant feed (stream service + kafka feeder + endpoint)

**Files:**
- Create: `apps/read-api/src/sse/order-stream.service.ts`, `sse-feeder.service.ts`, `merchant-sse.controller.ts`, `sse.module.ts`
- Modify: `apps/read-api/src/app.module.ts` (import SseModule)
- Create: `apps/read-api/test/order-stream.spec.ts`, `apps/read-api/test/sse.e2e-spec.ts`

- [ ] **Step 1: Write the failing unit test for the stream service**

Create `apps/read-api/test/order-stream.spec.ts`:
```ts
import { firstValueFrom } from "rxjs";
import { take, toArray } from "rxjs/operators";
import { OrderStreamService } from "../src/sse/order-stream.service";

describe("OrderStreamService", () => {
  it("delivers events to subscribers of the same tenant", async () => {
    const svc = new OrderStreamService();
    const got = firstValueFrom(svc.stream("berlin").pipe(take(1)));
    svc.publish("berlin", { orderId: "o-1", eventType: "OrderPlaced", status: "PLACED" });
    expect(await got).toMatchObject({ orderId: "o-1" });
  });

  it("isolates tenants — a tokyo event never reaches a berlin subscriber", async () => {
    const svc = new OrderStreamService();
    const berlin = firstValueFrom(svc.stream("berlin").pipe(take(1), toArray()));
    svc.publish("tokyo", { orderId: "t-1", eventType: "OrderPlaced", status: "PLACED" });
    svc.publish("berlin", { orderId: "b-1", eventType: "OrderPlaced", status: "PLACED" });
    const received = await berlin;
    expect(received).toHaveLength(1);
    expect(received[0].orderId).toBe("b-1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- apps/read-api/test/order-stream.spec.ts`
Expected: FAIL — `OrderStreamService` not found.

- [ ] **Step 3: Implement the stream service**

Create `apps/read-api/src/sse/order-stream.service.ts`:
```ts
import { Injectable } from "@nestjs/common";
import { Observable, Subject } from "rxjs";

export interface OrderStreamEvent {
  orderId: string;
  eventType: string;
  status?: string;
  [key: string]: unknown;
}

@Injectable()
export class OrderStreamService {
  private readonly subjects = new Map<string, Subject<OrderStreamEvent>>();

  private subjectFor(tenantId: string): Subject<OrderStreamEvent> {
    let s = this.subjects.get(tenantId);
    if (!s) {
      s = new Subject<OrderStreamEvent>();
      this.subjects.set(tenantId, s);
    }
    return s;
  }

  publish(tenantId: string, event: OrderStreamEvent): void {
    this.subjectFor(tenantId).next(event);
  }

  stream(tenantId: string): Observable<OrderStreamEvent> {
    return this.subjectFor(tenantId).asObservable();
  }
}
```

- [ ] **Step 4: Implement the kafka feeder + SSE controller + module**

Create `apps/read-api/src/sse/sse-feeder.service.ts`:
```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Kafka, logLevel, type Consumer } from "kafkajs";
import { loadConfig } from "@flashbite/shared";
import { TOPICS, type EventEnvelope, type OrderPlacedPayload } from "@flashbite/contracts";
import { OrderStreamService } from "./order-stream.service";

/** Maps an order-events envelope to the merchant SSE event shape. */
export function toStreamEvent(envelope: EventEnvelope) {
  const p = envelope.payload as Partial<OrderPlacedPayload>;
  return { orderId: p.orderId ?? "", eventType: envelope.eventType, status: "PLACED" };
}

@Injectable()
export class SseFeederService implements OnModuleInit, OnModuleDestroy {
  private consumer!: Consumer;
  constructor(private readonly stream: OrderStreamService) {}

  async onModuleInit(): Promise<void> {
    const config = loadConfig();
    const kafka = new Kafka({ clientId: "read-api-sse", brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
    this.consumer = kafka.consumer({ groupId: `read-api-sse-${process.pid}` });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const envelope = JSON.parse(message.value.toString()) as EventEnvelope;
        this.stream.publish(envelope.tenantId, toStreamEvent(envelope));
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
```

Create `apps/read-api/src/sse/merchant-sse.controller.ts`:
```ts
import { Controller, Sse } from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { getTenantId } from "@flashbite/tenant-context";
import { OrderStreamService } from "./order-stream.service";

interface MessageEvent {
  data: unknown;
}

@Controller("merchant/orders")
export class MerchantSseController {
  constructor(private readonly stream: OrderStreamService) {}

  @Sse("stream")
  ordersStream(): Observable<MessageEvent> {
    const tenantId = getTenantId();
    return this.stream.stream(tenantId).pipe(map((event) => ({ data: event })));
  }
}
```

Create `apps/read-api/src/sse/sse.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { OrderStreamService } from "./order-stream.service";
import { SseFeederService } from "./sse-feeder.service";
import { MerchantSseController } from "./merchant-sse.controller";

@Module({
  controllers: [MerchantSseController],
  providers: [OrderStreamService, SseFeederService],
})
export class SseModule {}
```

Update `apps/read-api/src/app.module.ts` (add SseModule):
```ts
import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { TenantMiddleware } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";
import { SseModule } from "./sse/sse.module";

@Module({
  imports: [OrdersModule, SseModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
```

- [ ] **Step 5: Write the SSE endpoint e2e test**

Create `apps/read-api/test/sse.e2e-spec.ts`:
```ts
import "reflect-metadata";
import http from "node:http";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { OrderStreamService } from "../src/sse/order-stream.service";

describe("read-api merchant SSE (e2e)", () => {
  let app: INestApplication;
  let stream: OrderStreamService;
  let port: number;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    stream = app.get(OrderStreamService);
  });
  afterAll(async () => {
    await app.close();
  });

  it("streams a published order event to the tenant's SSE client", async () => {
    const received = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/merchant/orders/stream", headers: { "X-Tenant-ID": "berlin" } },
        (res) => {
          res.setEncoding("utf8");
          let buf = "";
          res.on("data", (chunk: string) => {
            buf += chunk;
            if (buf.includes("o-sse-1")) {
              req.destroy();
              resolve(buf);
            }
          });
          res.on("error", reject);
        },
      );
      req.on("error", (e) => {
        // 'socket hang up' from our own destroy() is expected once resolved
        if (!/aborted|hang up|ECONNRESET/i.test(String(e))) reject(e);
      });
      // give the SSE subscription a moment to attach, then publish
      setTimeout(() => stream.publish("berlin", { orderId: "o-sse-1", eventType: "OrderPlaced", status: "PLACED" }), 400);
      setTimeout(() => reject(new Error("no SSE event received")), 9000);
    });
    expect(received).toContain("o-sse-1");
  }, 15000);
});
```

- [ ] **Step 6: Run to verify both pass**

Run: `pnpm test -- apps/read-api/test/order-stream.spec.ts apps/read-api/test/sse.e2e-spec.ts`
Expected: PASS — stream isolation unit tests + the SSE endpoint receives the published event.

- [ ] **Step 7: Run the whole read-api suite**

Run: `pnpm test -- apps/read-api`
Expected: PASS — health, orders query, cache-aside, stream, sse.

- [ ] **Step 8: Commit**

```bash
git add apps/read-api/src/sse apps/read-api/src/app.module.ts apps/read-api/test/order-stream.spec.ts apps/read-api/test/sse.e2e-spec.ts
git commit -m "feat(read-api): SSE merchant feed via per-tenant stream + kafka feeder"
```
End commit body with the `Co-Authored-By` line.

---

## Task 9: CI infra + run scripts + end-to-end verification

**Files:**
- Modify: `infra/docker-compose.ci.yml` (add mongodb + redis-cluster)
- Modify: `.github/workflows/test.yml` (add MONGO_URI + REDIS_CLUSTER_NODES env; wait for new services)
- Modify: root `package.json` (add `dev:read-api`, `dev:projection`)
- Create: `docs/superpowers/plans/phase-1b-verification.md`

- [ ] **Step 1: Add Mongo + Redis cluster to the CI compose**

Append these services to `infra/docker-compose.ci.yml` (under `services:`, keep postgres + redpanda):
```yaml
  mongodb:
    image: mongo:7.0
    ports:
      - "27017:27017"
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"]
      interval: 5s
      timeout: 5s
      retries: 20

  redis-cluster:
    image: grokzen/redis-cluster:7.0.15
    environment:
      IP: 0.0.0.0
      INITIAL_PORT: 7100
      MASTERS: 3
      SLAVES_PER_MASTER: 1
    ports:
      - "7100-7105:7100-7105"
      - "17100-17105:17100-17105"
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -p 7100 cluster info | grep -q cluster_state:ok"]
      interval: 5s
      timeout: 5s
      retries: 30
```

- [ ] **Step 2: Add env to the workflow**

In `.github/workflows/test.yml`, under the job-level `env:` block add (keep DATABASE_URL + KAFKA_BROKERS):
```yaml
      MONGO_URI: mongodb://localhost:27017/flashbite_read
      REDIS_CLUSTER_NODES: 127.0.0.1:7100,127.0.0.1:7101,127.0.0.1:7102,127.0.0.1:7103,127.0.0.1:7104,127.0.0.1:7105
```
(The existing `docker compose ... up -d --wait` step now also waits for mongodb + redis-cluster healthchecks. No other workflow change needed.)

- [ ] **Step 3: Add dev scripts**

In root `package.json` scripts, add (keep existing):
```json
    "dev:read-api": "node -r @swc-node/register -r tsconfig-paths/register --env-file=.env apps/read-api/src/main.ts",
    "dev:projection": "node -r @swc-node/register -r tsconfig-paths/register --env-file=.env apps/projection-worker/src/main.ts"
```

- [ ] **Step 4: Full local suite**

Run: `pnpm test`
Expected: all suites pass — Phase 1a (12) + Phase 1b (shared config/mongo/redis, projection unit + consumer, read-api health/query/cache/stream/sse). No regressions.

- [ ] **Step 5: Manual end-to-end (full command + query plane)**

With infra up, start all four services in the background:
```bash
pnpm dev:write-api      # 3001
pnpm dev:outbox
pnpm dev:projection
pnpm dev:read-api       # 3002
```
Then:
```bash
ORDER_ID=$(uuidgen)
curl -s -XPOST localhost:3001/orders -H 'Content-Type: application/json' -H 'X-Tenant-ID: berlin' \
  -d "{\"orderId\":\"$ORDER_ID\",\"customerId\":\"c-1\",\"items\":[{\"sku\":\"pizza\",\"qty\":1,\"price\":1200}],\"totalAmount\":1200}"
sleep 2
curl -s localhost:3002/orders/$ORDER_ID -H 'X-Tenant-ID: berlin'
```
Expected: the second curl returns the projected `OrderView` (status `PLACED`, totalAmount 1200) — proving write → outbox → Kafka → projection → Mongo → read-api. Optionally open the SSE feed (`curl -N localhost:3002/merchant/orders/stream -H 'X-Tenant-ID: berlin'`) in another terminal before POSTing to see the live event. Stop all background processes afterward (no orphans).

- [ ] **Step 6: Write the verification doc**

Create `docs/superpowers/plans/phase-1b-verification.md`:
```markdown
# Phase 1b — Verification

Prereq: `pnpm infra:up` (Postgres, Redpanda, MongoDB, Redis Cluster).

## Automated
`pnpm test` — Phase 1a + 1b suites (shared mongo/redis, projection-worker apply + consumer,
read-api health/query/cache-aside/stream/SSE).

## Manual end-to-end (command + query plane)
1. `pnpm dev:write-api` (3001), `pnpm dev:outbox`, `pnpm dev:projection`, `pnpm dev:read-api` (3002)
2. POST an order to write-api `/orders` (X-Tenant-ID: berlin).
3. GET read-api `/orders/<id>` -> returns the projected OrderView (status PLACED).
4. Optional: `curl -N localhost:3002/merchant/orders/stream -H 'X-Tenant-ID: berlin'` shows the live event.

Read side: projection-worker (Kafka -> Mongo, inbox dedup) + read-api (Mongo + Redis cache-aside + SSE).
Phase 1c adds the Temporal order-lifecycle saga + driver telemetry.
```

- [ ] **Step 7: Commit**

```bash
git add infra/docker-compose.ci.yml .github/workflows/test.yml package.json docs/superpowers/plans/phase-1b-verification.md
git commit -m "ci: add mongo+redis to CI; dev scripts + phase-1b verification"
```
End commit body with the `Co-Authored-By` line.

---

## Self-Review (completed by plan author)

**Spec coverage (master spec §6 Phase 1, query-plane slice + §3.2/§3.6):**
- projection-worker (Kafka → Mongo, inbox dedup) → Tasks 4–5. ✓
- read-api (Mongo + Redis cache) → Tasks 6–7. ✓
- SSE merchant feed → Task 8. ✓
- Inbox pattern keyed by (tenantId, consumer, eventId) → Mongo `processed_events`, Task 4. ✓
- Idempotency + ordering guard (version) → `applyEvent`, Task 4. ✓
- Redis `{tenant:id}` hash-tag keys (§3.3/§4) → Task 7 cache key + Task 3 client. ✓
- Tenant context from middleware (§3.3) → read-api reuses `@flashbite/tenant-context`, Tasks 6–8. ✓
- Envelope shape consumed verbatim (§3.4) → JSON.parse in consumer + feeder. ✓

**Placeholder scan:** No TBD/TODO. Every code/command step is complete.

**Type/name consistency:** `OrderView`, `READ_COLLECTIONS.ORDERS`/`.PROCESSED`, `ORDER_STATUS.PLACED`, `connectMongo`/`MongoHandle`/`MongoService`, `createRedisCluster`/`RedisService`, `applyEvent`/`CONSUMER_NAME` ("projection-worker"), `runConsumer`, `OrderStreamService.publish/stream`, `toStreamEvent`, cache key `{tenant:${tenantId}}:order:${orderId}:view`, read-model `_id` = `${tenantId}:${orderId}`, and inbox `_id` = `${tenantId}:${CONSUMER}:${eventId}` are used identically across producer (Phase 1a outbox envelope), worker, and read-api. The projection consumes the exact envelope the Phase 1a outbox-poller publishes (key `tenantId:orderId`, JSON envelope).

**Scope note:** Only OrderPlaced exists today, so projections set status `PLACED`; `applyEvent` already switches on `eventType` and marks unknown types processed (forward-compatible for Phase 1c's accept/fulfil/cancel events). The Temporal saga, telemetry, and frontends remain later phases. CI gains Mongo + Redis here (Task 9) so the new integration tests run in GitHub Actions.
```
