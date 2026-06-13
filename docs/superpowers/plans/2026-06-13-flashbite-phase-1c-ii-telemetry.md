# FlashBite Phase 1c-ii — Driver Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream driver GPS pings into Redis Cluster geospatial indices and expose a nearby-drivers query — the real-time telemetry plane of the showcase.

**Architecture:** A driver location `POST` on `read-api` publishes a `DriverTelemetryStreamed` envelope to the `telemetry-streams` Kafka topic (keyed `tenantId:driverId`). A plain-TS `telemetry-worker` consumes it and `GEOADD`s the driver into a per-tenant Redis geo key (`{tenant:id}:drivers:geo`). `read-api` answers `GET /drivers/nearby` with a `GEOSEARCH`. Telemetry is **ephemeral** — it never touches Postgres / the event store.

**Tech Stack:** kafkajs, Redis Cluster (ioredis GEO commands), NestJS (read-api), Jest + ts-jest, @swc-node/register runtime.

---

## Context for the implementer

Phases 1a–1c-i are in `main`. Reusable building blocks:
- `@flashbite/contracts` (pure): `EVENT_TYPES`, `TOPICS.TELEMETRY_STREAMS` (`"telemetry-streams"`), `CONSUMER_GROUPS`, `EventEnvelope`.
- `@flashbite/shared`: `buildEnvelope`, `createRedisCluster()` (ioredis `Cluster` with the grokzen natMap), `RedisService` (NestJS, exposes `.cluster`), `loadConfig` (`kafkaBrokers`, `redisClusterNodes`).
- `read-api` (NestJS, idiomatic DI, `@swc-node/register`) already runs a Kafka consumer (SSE feeder) and uses `RedisService`.
- Plain-TS worker pattern: `outbox-poller` / `projection-worker` (a pure unit fn + a `runConsumer` loop + `require.main` guard).

**Before starting:** `pnpm infra:up`; confirm Redpanda (9092), Redis Cluster (7100-7105) healthy. The `telemetry-streams` topic (12 partitions) already exists (Phase 0 infra + CI both create it).

**Decisions locked:**
- **Ephemeral:** telemetry is NOT written to Postgres/outbox. The ingest endpoint produces straight to Kafka; the worker writes only Redis. No event store rows.
- **Envelope reuse:** the wire message is a normal `EventEnvelope` (`eventType: DriverTelemetryStreamed`) built with `buildEnvelope` — consistent shape, but not persisted. Partition key `tenantId:driverId` keeps a driver's pings ordered on one partition.
- **Geo key:** `{tenant:${tenantId}}:drivers:geo` (hash tag → one cluster slot; GEO commands need all data on one key). Centralized as `driverGeoKey(tenantId)` in contracts (pure helper).
- **telemetry-worker is plain TS** (consumer + `applyTelemetry`); ingest + query live in `read-api` (NestJS).
- Runtime `@swc-node/register`; idiomatic DI (no `@Inject`).

**Conventions:** commit per task (Conventional Commits); UUIDs via `node:crypto`; tests `*.spec.ts`/`*.e2e-spec.ts` (root jest, serial + forceExit, loads `.env`).

---

## File Structure

```
flashbite/
  packages/contracts/src/index.ts        # MODIFY: DriverTelemetryPayload, event type, TELEMETRY group, driverGeoKey()
  packages/contracts/src/contracts.spec.ts # MODIFY: assert driverGeoKey + new constants
  apps/
    telemetry-worker/
      package.json                        # CREATE
      tsconfig.json                       # CREATE
      src/telemetry.ts                    # CREATE: applyTelemetry(cluster, envelope)
      src/main.ts                         # CREATE: kafka consumer loop
      test/telemetry.spec.ts              # CREATE
      test/consumer.spec.ts               # CREATE (integration)
    read-api/
      src/drivers/driver-location.dto.ts  # CREATE
      src/drivers/telemetry-producer.service.ts # CREATE
      src/drivers/drivers.controller.ts   # CREATE (POST location + GET nearby)
      src/drivers/drivers.module.ts       # CREATE
      src/app.module.ts                   # MODIFY: import DriversModule
      test/telemetry-ingest.e2e-spec.ts   # CREATE
      test/drivers-nearby.e2e-spec.ts     # CREATE
  package.json                            # MODIFY (Task 6): dev:telemetry
  docs/superpowers/plans/phase-1c-ii-verification.md # CREATE (Task 6)
```

---

## Task 1: contracts — telemetry payload, event type, geo key

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/contracts.spec.ts`

- [ ] **Step 1: Add failing assertions**

In `packages/contracts/src/contracts.spec.ts`, add this test inside the `describe("contracts constants", ...)` block (and add `CONSUMER_GROUPS`, `EVENT_TYPES`, `driverGeoKey` to the imports if not present):
```ts
  it("exposes telemetry constants + geo key helper", () => {
    expect(EVENT_TYPES.DRIVER_TELEMETRY_STREAMED).toBe("DriverTelemetryStreamed");
    expect(CONSUMER_GROUPS.TELEMETRY).toBe("telemetry-worker");
    expect(driverGeoKey("berlin")).toBe("{tenant:berlin}:drivers:geo");
  });
```

- [ ] **Step 2: Run -> FAIL**

Run: `pnpm test -- packages/contracts/src/contracts.spec.ts`
Expected: FAIL — `DRIVER_TELEMETRY_STREAMED`/`TELEMETRY`/`driverGeoKey` missing.

- [ ] **Step 3: Implement in contracts**

In `packages/contracts/src/index.ts`:

Add to `EVENT_TYPES` (keep existing entries):
```ts
  DRIVER_TELEMETRY_STREAMED: "DriverTelemetryStreamed",
```
Add to `CONSUMER_GROUPS` (keep existing entries):
```ts
  TELEMETRY: "telemetry-worker",
```
Add the payload interface + key helper (anywhere among the other exports):
```ts
export interface DriverTelemetryPayload {
  driverId: string;
  orderId?: string;
  lng: number;
  lat: number;
}

/** Per-tenant Redis geo key for live driver locations. The {tenant:id} hash tag
 *  co-locates the key on one cluster slot (GEO commands operate on a single key). */
export function driverGeoKey(tenantId: string): string {
  return `{tenant:${tenantId}}:drivers:geo`;
}
```

- [ ] **Step 4: Run -> PASS**

Run: `pnpm test -- packages/contracts/src/contracts.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/contracts.spec.ts
git commit -m "feat(contracts): driver telemetry payload, event type, geo key helper"
```
End commit body with:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Task 2: telemetry-worker — applyTelemetry (GEOADD)

**Files:**
- Create: `apps/telemetry-worker/package.json`, `apps/telemetry-worker/tsconfig.json`
- Create: `apps/telemetry-worker/src/telemetry.ts`
- Create: `apps/telemetry-worker/test/telemetry.spec.ts`

- [ ] **Step 1: Create package + tsconfig**

Create `apps/telemetry-worker/package.json`:
```json
{
  "name": "@flashbite/telemetry-worker",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "start": "node -r @swc-node/register -r tsconfig-paths/register src/main.ts"
  },
  "dependencies": {
    "@flashbite/contracts": "workspace:*",
    "@flashbite/shared": "workspace:*",
    "ioredis": "5.4.1",
    "kafkajs": "2.2.4"
  }
}
```

Create `apps/telemetry-worker/tsconfig.json`:
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

Create `apps/telemetry-worker/test/telemetry.spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { createRedisCluster, buildEnvelope } from "@flashbite/shared";
import { EVENT_TYPES, driverGeoKey, type DriverTelemetryPayload } from "@flashbite/contracts";
import { applyTelemetry } from "../src/telemetry";

describe("applyTelemetry", () => {
  const cluster = createRedisCluster();
  afterAll(async () => {
    await cluster.quit();
  });

  const ping = (driverId: string, lng: number, lat: number) =>
    buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED,
      version: 1,
      payload: { driverId, lng, lat } as DriverTelemetryPayload,
    });

  it("GEOADDs a driver into the tenant geo key and is queryable", async () => {
    const driverId = `d-${randomUUID()}`;
    await applyTelemetry(cluster, ping(driverId, 13.405, 52.52)); // Berlin

    const pos = (await cluster.geopos(driverGeoKey("berlin"), driverId)) as Array<[string, string] | null>;
    expect(pos[0]).not.toBeNull();
    expect(Number(pos[0]![0])).toBeCloseTo(13.405, 2);

    await cluster.zrem(driverGeoKey("berlin"), driverId);
  });

  it("isolates tenants — a berlin driver is absent from tokyo's geo key", async () => {
    const driverId = `d-${randomUUID()}`;
    await applyTelemetry(cluster, ping(driverId, 13.405, 52.52));
    const tokyoPos = (await cluster.geopos(driverGeoKey("tokyo"), driverId)) as Array<[string, string] | null>;
    expect(tokyoPos[0]).toBeNull();
    await cluster.zrem(driverGeoKey("berlin"), driverId);
  });
});
```

- [ ] **Step 3: Run -> FAIL**

Run: `pnpm install && pnpm test -- apps/telemetry-worker/test/telemetry.spec.ts`
Expected: FAIL — `applyTelemetry` not found.

- [ ] **Step 4: Implement**

Create `apps/telemetry-worker/src/telemetry.ts`:
```ts
import type { Cluster } from "ioredis";
import { driverGeoKey, type EventEnvelope, type DriverTelemetryPayload } from "@flashbite/contracts";

/**
 * Writes one driver GPS ping into the tenant's Redis geo set. Ephemeral — no
 * Postgres. GEOADD is idempotent per member (latest position wins).
 */
export async function applyTelemetry(cluster: Cluster, envelope: EventEnvelope): Promise<void> {
  const p = envelope.payload as DriverTelemetryPayload;
  await cluster.geoadd(driverGeoKey(envelope.tenantId), p.lng, p.lat, p.driverId);
}
```

- [ ] **Step 5: Run -> PASS**

Run: `pnpm test -- apps/telemetry-worker/test/telemetry.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/telemetry-worker pnpm-lock.yaml
git commit -m "feat(telemetry-worker): applyTelemetry GEOADD into per-tenant geo key"
```
End commit body with the `Co-Authored-By` line.

---

## Task 3: telemetry-worker — Kafka consumer loop

**Files:**
- Create: `apps/telemetry-worker/src/main.ts`
- Create: `apps/telemetry-worker/test/consumer.spec.ts`

- [ ] **Step 1: Write the failing integration test**

Create `apps/telemetry-worker/test/consumer.spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { createRedisCluster, buildEnvelope } from "@flashbite/shared";
import { EVENT_TYPES, TOPICS, driverGeoKey, type DriverTelemetryPayload } from "@flashbite/contracts";
import { runTelemetryConsumer } from "../src/main";

describe("telemetry-worker consumer (integration)", () => {
  const cluster = createRedisCluster();
  const kafka = new Kafka({ clientId: "telemetry-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });

  afterAll(async () => {
    await cluster.quit();
  });

  it("consumes a telemetry envelope and GEOADDs the driver", async () => {
    const driverId = `d-${randomUUID()}`;
    const envelope = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED,
      version: 1,
      payload: { driverId, lng: 13.405, lat: 52.52 } as DriverTelemetryPayload,
    });

    const consumer = kafka.consumer({ groupId: `telemetry-worker-test-${Date.now()}` });
    const handle = await runTelemetryConsumer(consumer, cluster);

    const producer = kafka.producer();
    await producer.connect();
    await producer.send({
      topic: TOPICS.TELEMETRY_STREAMS,
      messages: [{ key: `berlin:${driverId}`, value: JSON.stringify(envelope) }],
    });
    await producer.disconnect();

    let pos: Array<[string, string] | null> = [null];
    for (let i = 0; i < 50 && !pos[0]; i++) {
      pos = (await cluster.geopos(driverGeoKey("berlin"), driverId)) as Array<[string, string] | null>;
      if (!pos[0]) await new Promise((r) => setTimeout(r, 200));
    }
    expect(pos[0]).not.toBeNull();

    await handle.stop();
    await cluster.zrem(driverGeoKey("berlin"), driverId);
  }, 30000);
});
```

- [ ] **Step 2: Run -> FAIL**

Run: `pnpm test -- apps/telemetry-worker/test/consumer.spec.ts`
Expected: FAIL — `runTelemetryConsumer` not exported.

- [ ] **Step 3: Implement main**

Create `apps/telemetry-worker/src/main.ts`:
```ts
import { Kafka, logLevel, type Consumer } from "kafkajs";
import type { Cluster } from "ioredis";
import { createRedisCluster, loadConfig } from "@flashbite/shared";
import { CONSUMER_GROUPS, TOPICS, type EventEnvelope } from "@flashbite/contracts";
import { applyTelemetry } from "./telemetry";

export interface TelemetryConsumerHandle {
  stop: () => Promise<void>;
}

/** Wires a kafkajs consumer to applyTelemetry. Returns a stop handle. */
export async function runTelemetryConsumer(consumer: Consumer, cluster: Cluster): Promise<TelemetryConsumerHandle> {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.TELEMETRY_STREAMS, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const envelope = JSON.parse(message.value.toString()) as EventEnvelope;
      await applyTelemetry(cluster, envelope);
    },
  });
  return { stop: async () => { await consumer.disconnect(); } };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const cluster = createRedisCluster();
  const kafka = new Kafka({ clientId: "telemetry-worker", brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.TELEMETRY });
  const handle = await runTelemetryConsumer(consumer, cluster);

  // eslint-disable-next-line no-console
  console.log("telemetry-worker running");
  const shutdown = async (): Promise<void> => {
    await handle.stop();
    await cluster.quit();
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

- [ ] **Step 4: Run -> PASS**

Run: `pnpm test -- apps/telemetry-worker/test/consumer.spec.ts`
Expected: PASS — produced ping lands in the geo key.

- [ ] **Step 5: Commit**

```bash
git add apps/telemetry-worker/src/main.ts apps/telemetry-worker/test/consumer.spec.ts
git commit -m "feat(telemetry-worker): kafka consumer loop -> Redis geo"
```
End commit body with the `Co-Authored-By` line.

---

## Task 4: read-api — telemetry ingest endpoint

**Files:**
- Create: `apps/read-api/src/drivers/driver-location.dto.ts`
- Create: `apps/read-api/src/drivers/telemetry-producer.service.ts`
- Create: `apps/read-api/src/drivers/drivers.controller.ts`
- Create: `apps/read-api/src/drivers/drivers.module.ts`
- Modify: `apps/read-api/src/app.module.ts`
- Modify: `apps/read-api/package.json` (ensure `class-validator`, `class-transformer`)
- Create: `apps/read-api/test/telemetry-ingest.e2e-spec.ts`

- [ ] **Step 1: Ensure validation deps**

In `apps/read-api/package.json` dependencies add (keep existing; these may already be present transitively but declare them):
```json
    "class-transformer": "0.5.1",
    "class-validator": "0.14.1"
```
Then `pnpm install`.

- [ ] **Step 2: Write the failing ingest e2e**

Create `apps/read-api/test/telemetry-ingest.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { AppModule } from "../src/app.module";
import { TOPICS, type EventEnvelope, type DriverTelemetryPayload } from "@flashbite/contracts";

describe("read-api telemetry ingest (e2e)", () => {
  let app: INestApplication;
  const kafka = new Kafka({ clientId: "ingest-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  }, 30000);
  afterAll(async () => {
    await app.close();
  });

  it("POST /drivers/:id/location publishes a DriverTelemetryStreamed envelope to telemetry-streams", async () => {
    const driverId = `d-${randomUUID()}`;

    const admin = kafka.admin();
    await admin.connect();
    const before = await admin.fetchTopicOffsets(TOPICS.TELEMETRY_STREAMS);
    await admin.disconnect();
    const startOffsets = new Map(before.map((w) => [w.partition, BigInt(w.high)]));

    const res = await request(app.getHttpServer())
      .post(`/drivers/${driverId}/location`)
      .set("X-Tenant-ID", "berlin")
      .send({ lng: 13.405, lat: 52.52 });
    expect(res.status).toBe(202);

    const consumer = kafka.consumer({ groupId: `ingest-test-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: TOPICS.TELEMETRY_STREAMS, fromBeginning: true });
    const got: EventEnvelope = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no telemetry message")), 10000);
      consumer.on(consumer.events.GROUP_JOIN, () => {
        for (const [p, o] of startOffsets) consumer.seek({ topic: TOPICS.TELEMETRY_STREAMS, partition: p, offset: o.toString() });
      });
      consumer.run({
        eachMessage: async ({ partition, message }) => {
          if (BigInt(message.offset) < (startOffsets.get(partition) ?? 0n)) return;
          const env = JSON.parse(message.value!.toString()) as EventEnvelope;
          if ((env.payload as DriverTelemetryPayload).driverId === driverId) {
            clearTimeout(timer);
            resolve(env);
          }
        },
      }).catch(reject);
    });
    await consumer.disconnect();

    expect(got.eventType).toBe("DriverTelemetryStreamed");
    expect(got.tenantId).toBe("berlin");
    expect((got.payload as DriverTelemetryPayload).lat).toBe(52.52);
  }, 30000);
});
```

- [ ] **Step 3: Run -> FAIL**

Run: `pnpm install && pnpm test -- apps/read-api/test/telemetry-ingest.e2e-spec.ts`
Expected: FAIL — route 404.

- [ ] **Step 4: Implement the DTO**

Create `apps/read-api/src/drivers/driver-location.dto.ts`:
```ts
import { IsNumber, IsOptional, IsString, Max, Min } from "class-validator";

export class DriverLocationDto {
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsOptional() @IsString() orderId?: string;
}
```

- [ ] **Step 5: Implement the telemetry producer**

Create `apps/read-api/src/drivers/telemetry-producer.service.ts`:
```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Kafka, logLevel, type Producer } from "kafkajs";
import { buildEnvelope, loadConfig } from "@flashbite/shared";
import { EVENT_TYPES, TOPICS, type DriverTelemetryPayload } from "@flashbite/contracts";

@Injectable()
export class TelemetryProducerService implements OnModuleInit, OnModuleDestroy {
  private producer!: Producer;

  async onModuleInit(): Promise<void> {
    const kafka = new Kafka({ clientId: "read-api-telemetry", brokers: loadConfig().kafkaBrokers, logLevel: logLevel.NOTHING });
    this.producer = kafka.producer();
    await this.producer.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer?.disconnect();
  }

  async publish(tenantId: string, payload: DriverTelemetryPayload): Promise<void> {
    const envelope = buildEnvelope({
      tenantId,
      eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED,
      version: 1,
      payload,
    });
    await this.producer.send({
      topic: TOPICS.TELEMETRY_STREAMS,
      messages: [{ key: `${tenantId}:${payload.driverId}`, value: JSON.stringify(envelope) }],
    });
  }
}
```

- [ ] **Step 6: Implement the controller + module, wire into AppModule**

Create `apps/read-api/src/drivers/drivers.controller.ts` (ingest only for now; nearby added in Task 5):
```ts
import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { getTenantId } from "@flashbite/tenant-context";
import { DriverLocationDto } from "./driver-location.dto";
import { TelemetryProducerService } from "./telemetry-producer.service";

@Controller("drivers")
export class DriversController {
  constructor(private readonly telemetry: TelemetryProducerService) {}

  @Post(":driverId/location")
  @HttpCode(202)
  async reportLocation(
    @Param("driverId") driverId: string,
    @Body() dto: DriverLocationDto,
  ): Promise<{ driverId: string }> {
    const tenantId = getTenantId();
    await this.telemetry.publish(tenantId, { driverId, lng: dto.lng, lat: dto.lat, orderId: dto.orderId });
    return { driverId };
  }
}
```

Create `apps/read-api/src/drivers/drivers.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { RedisService } from "@flashbite/shared";
import { DriversController } from "./drivers.controller";
import { TelemetryProducerService } from "./telemetry-producer.service";

@Module({
  controllers: [DriversController],
  providers: [TelemetryProducerService, RedisService],
})
export class DriversModule {}
```

Update `apps/read-api/src/app.module.ts` to import `DriversModule` (keep OrdersModule, SseModule, HealthController, middleware):
```ts
import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { TenantMiddleware } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";
import { SseModule } from "./sse/sse.module";
import { DriversModule } from "./drivers/drivers.module";

@Module({
  imports: [OrdersModule, SseModule, DriversModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
```

- [ ] **Step 7: Run -> PASS**

Run: `pnpm test -- apps/read-api/test/telemetry-ingest.e2e-spec.ts`
Expected: PASS — 202; envelope on `telemetry-streams` with the driver location.

- [ ] **Step 8: Commit**

```bash
git add apps/read-api/src/drivers apps/read-api/src/app.module.ts apps/read-api/package.json apps/read-api/test/telemetry-ingest.e2e-spec.ts pnpm-lock.yaml
git commit -m "feat(read-api): driver location ingest -> telemetry-streams"
```
End commit body with the `Co-Authored-By` line.

---

## Task 5: read-api — nearby-drivers query (GEOSEARCH)

**Files:**
- Modify: `apps/read-api/src/drivers/drivers.controller.ts`
- Create: `apps/read-api/test/drivers-nearby.e2e-spec.ts`

- [ ] **Step 1: Write the failing nearby e2e**

Create `apps/read-api/test/drivers-nearby.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { RedisService } from "@flashbite/shared";
import { driverGeoKey } from "@flashbite/contracts";

describe("read-api nearby drivers (e2e)", () => {
  let app: INestApplication;
  let redis: RedisService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    redis = app.get(RedisService);
  }, 30000);
  afterAll(async () => {
    await app.close();
  });

  it("returns drivers within the radius for the tenant", async () => {
    const near = `near-${randomUUID()}`;
    const far = `far-${randomUUID()}`;
    // Berlin centre ~ (13.405, 52.52); near ~1km away, far ~ Munich (very far)
    await redis.cluster.geoadd(driverGeoKey("berlin"), 13.41, 52.52, near);
    await redis.cluster.geoadd(driverGeoKey("berlin"), 11.58, 48.14, far);

    const res = await request(app.getHttpServer())
      .get(`/drivers/nearby?lng=13.405&lat=52.52&radiusKm=5`)
      .set("X-Tenant-ID", "berlin");
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ driverId: string }>).map((d) => d.driverId);
    expect(ids).toContain(near);
    expect(ids).not.toContain(far);

    await redis.cluster.zrem(driverGeoKey("berlin"), near, far);
  });

  it("does not see another tenant's drivers", async () => {
    const tokyoDriver = `tk-${randomUUID()}`;
    await redis.cluster.geoadd(driverGeoKey("tokyo"), 13.405, 52.52, tokyoDriver);
    const res = await request(app.getHttpServer())
      .get(`/drivers/nearby?lng=13.405&lat=52.52&radiusKm=5`)
      .set("X-Tenant-ID", "berlin");
    const ids = (res.body as Array<{ driverId: string }>).map((d) => d.driverId);
    expect(ids).not.toContain(tokyoDriver);
    await redis.cluster.zrem(driverGeoKey("tokyo"), tokyoDriver);
  });
});
```

- [ ] **Step 2: Run -> FAIL**

Run: `pnpm test -- apps/read-api/test/drivers-nearby.e2e-spec.ts`
Expected: FAIL — `/drivers/nearby` 404.

- [ ] **Step 3: Add the nearby query to the controller**

Replace `apps/read-api/src/drivers/drivers.controller.ts` with (keeps the ingest POST, adds the GET + RedisService):
```ts
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { getTenantId } from "@flashbite/tenant-context";
import { RedisService } from "@flashbite/shared";
import { driverGeoKey } from "@flashbite/contracts";
import { DriverLocationDto } from "./driver-location.dto";
import { TelemetryProducerService } from "./telemetry-producer.service";

interface NearbyDriver {
  driverId: string;
  distanceKm: number;
  lng: number;
  lat: number;
}

@Controller("drivers")
export class DriversController {
  constructor(
    private readonly telemetry: TelemetryProducerService,
    private readonly redis: RedisService,
  ) {}

  @Post(":driverId/location")
  @HttpCode(202)
  async reportLocation(
    @Param("driverId") driverId: string,
    @Body() dto: DriverLocationDto,
  ): Promise<{ driverId: string }> {
    const tenantId = getTenantId();
    await this.telemetry.publish(tenantId, { driverId, lng: dto.lng, lat: dto.lat, orderId: dto.orderId });
    return { driverId };
  }

  @Get("nearby")
  async nearby(
    @Query("lng") lng: string,
    @Query("lat") lat: string,
    @Query("radiusKm") radiusKm = "5",
  ): Promise<NearbyDriver[]> {
    const tenantId = getTenantId();
    const raw = (await this.redis.cluster.geosearch(
      driverGeoKey(tenantId),
      "FROMLONLAT",
      lng,
      lat,
      "BYRADIUS",
      radiusKm,
      "km",
      "ASC",
      "WITHDIST",
      "WITHCOORD",
    )) as Array<[string, string, [string, string]]>;

    return raw.map(([driverId, dist, [dlng, dlat]]) => ({
      driverId,
      distanceKm: Number(dist),
      lng: Number(dlng),
      lat: Number(dlat),
    }));
  }
}
```

- [ ] **Step 4: Provide RedisService in the module**

Update `apps/read-api/src/drivers/drivers.module.ts` providers already include `RedisService` (from Task 4) — confirm it lists `TelemetryProducerService` AND `RedisService`. If not, set:
```ts
  providers: [TelemetryProducerService, RedisService],
```

- [ ] **Step 5: Run -> PASS**

Run: `pnpm test -- apps/read-api/test/drivers-nearby.e2e-spec.ts`
Expected: PASS — near driver returned, far + other-tenant excluded.

- [ ] **Step 6: Run the whole read-api suite**

Run: `pnpm test -- apps/read-api`
Expected: PASS — health, orders, cache, stream, sse, telemetry ingest, nearby.

- [ ] **Step 7: Commit**

```bash
git add apps/read-api/src/drivers/drivers.controller.ts apps/read-api/src/drivers/drivers.module.ts apps/read-api/test/drivers-nearby.e2e-spec.ts
git commit -m "feat(read-api): GET /drivers/nearby via Redis GEOSEARCH"
```
End commit body with the `Co-Authored-By` line.

---

## Task 6: dev script + full verification

**Files:**
- Modify: root `package.json`
- Create: `docs/superpowers/plans/phase-1c-ii-verification.md`

(CI already provisions Redis + Redpanda + the `telemetry-streams` topic, so no `docker-compose.ci.yml` / workflow change is needed for these tests.)

- [ ] **Step 1: Add the dev:telemetry script**

In root `package.json` scripts add (keep existing):
```json
    "dev:telemetry": "node -r @swc-node/register -r tsconfig-paths/register --env-file=.env apps/telemetry-worker/src/main.ts"
```

- [ ] **Step 2: Full local suite**

Run: `pnpm test`
Expected: all suites pass (1a + 1b + 1c-i + 1c-ii: contracts telemetry, telemetry-worker apply + consumer, read-api telemetry ingest + nearby). Serial + clean exit. Report totals.

- [ ] **Step 3: Manual end-to-end (telemetry)**

With infra up, start `pnpm dev:read-api` (3002) and `pnpm dev:telemetry`. Then:
```bash
DRIVER=drv-1
curl -s -XPOST localhost:3002/drivers/$DRIVER/location -H 'Content-Type: application/json' -H 'X-Tenant-ID: berlin' \
  -d '{"lng":13.405,"lat":52.52}'
sleep 2
curl -s "localhost:3002/drivers/nearby?lng=13.405&lat=52.52&radiusKm=5" -H 'X-Tenant-ID: berlin'
```
Expected: the POST returns `{"driverId":"drv-1"}` (202); after the worker consumes, the nearby query returns `drv-1` with a small `distanceKm`. Report both responses. Stop both processes (no orphans).

- [ ] **Step 4: Verification doc**

Create `docs/superpowers/plans/phase-1c-ii-verification.md`:
```markdown
# Phase 1c-ii — Verification

Prereq: `pnpm infra:up` (Redpanda + Redis Cluster at minimum).

## Automated
`pnpm test` — contracts telemetry (geo key), telemetry-worker (applyTelemetry + consumer),
read-api (telemetry ingest -> telemetry-streams, GET /drivers/nearby GEOSEARCH, tenant isolation).

## Manual end-to-end
1. `pnpm dev:read-api` (3002) + `pnpm dev:telemetry`.
2. POST /drivers/<id>/location (X-Tenant-ID: berlin) with {lng,lat} -> 202.
3. read-api publishes DriverTelemetryStreamed -> telemetry-streams -> telemetry-worker GEOADDs
   into {tenant:berlin}:drivers:geo.
4. GET /drivers/nearby?lng&lat&radiusKm -> the driver appears (tenant-scoped).

Telemetry is ephemeral (Redis geo only; never persisted to Postgres).
Phase 1d builds the frontends (customer storefront, merchant dashboard, driver GPS emitter, admin grid).
```

- [ ] **Step 5: Commit**

```bash
git add package.json docs/superpowers/plans/phase-1c-ii-verification.md
git commit -m "chore(telemetry): dev:telemetry script + phase-1c-ii verification"
```
End commit body with the `Co-Authored-By` line.

---

## Self-Review (completed by plan author)

**Spec coverage (master spec §2.1 / §3.3 driver telemetry isolation, §5 DriverTelemetryStreamed, Redis geo):**
- Driver GPS → Kafka → worker → Redis geo → query → Tasks 2–5. ✓
- High-velocity telemetry isolated per tenant (`{tenant:id}:drivers:geo`, hash-tag co-location) → Task 1 key helper; isolation asserted in Tasks 2 + 5. ✓
- Ephemeral (Redis geospatial, not event-sourced) → ingest produces straight to Kafka; worker writes only Redis; no Postgres/outbox. ✓
- `DriverTelemetryStreamed` event on `telemetry-streams` → Task 1 event type + Task 4 ingest. ✓
- Partition key per driver (`tenantId:driverId`) → Task 4 producer. ✓

**Placeholder scan:** No TBD/TODO; every code/command step is complete.

**Type/name consistency:** `DriverTelemetryPayload {driverId, orderId?, lng, lat}`, `EVENT_TYPES.DRIVER_TELEMETRY_STREAMED` ("DriverTelemetryStreamed"), `CONSUMER_GROUPS.TELEMETRY` ("telemetry-worker"), `driverGeoKey(tenantId)` → `{tenant:${tenantId}}:drivers:geo`, `applyTelemetry(cluster, envelope)`, `runTelemetryConsumer(consumer, cluster)`, `TelemetryProducerService.publish(tenantId, payload)`, routes `POST /drivers/:driverId/location` (202) + `GET /drivers/nearby`, and `TOPICS.TELEMETRY_STREAMS` are used identically across contracts, telemetry-worker, read-api, and tests. The ingest producer writes the exact envelope shape the worker's `applyTelemetry` reads.

**Scope note:** No HTTP map/visualization — `GET /drivers/nearby` returns JSON; the driver GPS emitter UI and live map are Phase 1d. CI needs no change (Redis + Redpanda + `telemetry-streams` already provisioned). GEO commands run on a single hash-tagged key, valid under Redis Cluster.
```
