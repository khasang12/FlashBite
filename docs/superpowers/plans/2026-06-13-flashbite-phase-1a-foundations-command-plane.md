# FlashBite Phase 1a — Foundations + Command Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the command side of the walking skeleton — a NestJS `write-api` that accepts an order, writes the domain event + outbox row atomically (idempotently), and an `outbox-poller` that relays pending rows to Redpanda as JSON envelopes.

**Architecture:** CommonJS NestJS apps in a pnpm monorepo. Shared logic lives in three workspace packages (`contracts`, `shared`, `tenant-context`) consumed via TypeScript path aliases (no build step). Persistence is Prisma against the Phase 0 Postgres; events go onto the existing `order-events` Redpanda topic. One hardcoded tenant for now; idempotency is enforced by a unique `(tenant_id, aggregate_id, version)` constraint on the event store.

**Tech Stack:** NestJS 10 (CommonJS), Prisma 5 + PostgreSQL, kafkajs, Jest + ts-jest, class-validator, tsconfig-paths.

---

## Context for the implementer

The repo already has Phase 0 done: a pnpm workspace, `infra/docker-compose.yml`, and the running stack. **Before starting, run `pnpm infra:up` and confirm Postgres (5432) and Redpanda (9092) are healthy** — every integration test in this plan hits the live stack. The topic `order-events` (6 partitions) already exists.

Master spec: `docs/superpowers/specs/2026-06-13-flashbite-showcase-design.md` (read §3.2 command plane, §3.6 idempotency, §3.3 tenant context).

**Decisions locked for this sub-plan (do not deviate without escalating):**
- **Module system: CommonJS.** Apps and packages are CJS (no `"type": "module"`). This is required for NestJS DI metadata under ts-jest.
- **Workspace packages via path aliases**, resolved at runtime by `tsconfig-paths` (`nest start -r tsconfig-paths/register`) and in tests by ts-jest's `pathsToModuleNameMapper`. No per-package build step in Phase 1.
- **JSON on the wire** (Avro is Phase 3). The outbox `payload` column stores the full event envelope as JSON; the poller publishes it verbatim.
- **One hardcoded tenant**: `DEFAULT_TENANT_ID = "berlin"`. Real tenant resolution / identity is Phase 2.
- **Idempotency key = the client-supplied `orderId`** (the aggregate id). A second create for the same order collapses to the original event via the unique constraint.

**Conventions:** commit after every task (Conventional Commits). UUIDs come from `node:crypto`'s `randomUUID` (no `uuid` dep).

---

## File Structure

```
flashbite/
  tsconfig.base.json                 # MODIFY: add baseUrl + path aliases
  jest.config.cjs                    # CREATE: root jest config (ts-jest, path mapping)
  .env.example                       # MODIFY: add DATABASE_URL
  packages/
    contracts/
      package.json                   # @flashbite/contracts
      tsconfig.json
      src/index.ts                   # envelope + event types + buildEnvelope
      src/contracts.spec.ts
    shared/
      package.json                   # @flashbite/shared (prisma, config)
      tsconfig.json
      prisma/schema.prisma           # event_store, outbox, processed_events
      src/index.ts                   # re-exports
      src/config.ts                  # env config loader
      src/prisma.service.ts          # NestJS-injectable Prisma client
      src/config.spec.ts
    tenant-context/
      package.json                   # @flashbite/tenant-context
      tsconfig.json
      src/index.ts                   # re-exports
      src/tenant-context.ts          # AsyncLocalStorage store + helpers
      src/tenant.middleware.ts       # NestJS middleware
      src/tenant-context.spec.ts
  apps/
    write-api/
      package.json
      tsconfig.json
      tsconfig.build.json
      nest-cli.json
      src/main.ts
      src/app.module.ts
      src/health.controller.ts
      src/orders/orders.module.ts
      src/orders/create-order.dto.ts
      src/orders/orders.service.ts
      src/orders/orders.controller.ts
      test/orders.e2e-spec.ts
    outbox-poller/
      package.json
      tsconfig.json
      src/main.ts
      src/poller.ts
      test/poller.spec.ts
```

---

## Task 1: Workspace tooling — path aliases, Jest, env

**Files:**
- Modify: `tsconfig.base.json`
- Create: `jest.config.cjs`
- Modify: `package.json` (root devDeps + scripts)
- Modify: `.env.example`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json` (needed so the alias resolves and the sanity test runs)
- Create: `packages/contracts/src/index.ts` (temporary sanity export, replaced in Task 2)
- Create: `packages/contracts/src/sanity.spec.ts`

- [ ] **Step 1: Add path aliases to `tsconfig.base.json`**

Replace the file with (adds `baseUrl` + `paths`, keeps existing options):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "baseUrl": ".",
    "paths": {
      "@flashbite/contracts": ["packages/contracts/src/index.ts"],
      "@flashbite/shared": ["packages/shared/src/index.ts"],
      "@flashbite/tenant-context": ["packages/tenant-context/src/index.ts"]
    }
  }
}
```

- [ ] **Step 2: Add root devDependencies and scripts**

Update `package.json` — keep existing `infra:*` scripts, add the `test` script and devDeps:
```json
{
  "name": "flashbite",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.1.0",
  "scripts": {
    "infra:up": "docker compose -f infra/docker-compose.yml up -d",
    "infra:down": "docker compose -f infra/docker-compose.yml down",
    "infra:nuke": "docker compose -f infra/docker-compose.yml down -v",
    "infra:ps": "docker compose -f infra/docker-compose.yml ps",
    "test": "jest"
  },
  "devDependencies": {
    "typescript": "5.5.4",
    "tsx": "4.16.2",
    "@types/node": "20.14.12",
    "jest": "29.7.0",
    "ts-jest": "29.2.4",
    "@types/jest": "29.5.12",
    "tsconfig-paths": "4.2.0"
  }
}
```

- [ ] **Step 3: Create the root Jest config**

Create `jest.config.cjs` (CommonJS config; maps the workspace aliases to source so tests need no build):
```js
const { pathsToModuleNameMapper } = require("ts-jest");

const paths = {
  "@flashbite/contracts": ["packages/contracts/src/index.ts"],
  "@flashbite/shared": ["packages/shared/src/index.ts"],
  "@flashbite/tenant-context": ["packages/tenant-context/src/index.ts"],
};

module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/packages", "<rootDir>/apps"],
  moduleNameMapper: pathsToModuleNameMapper(paths, { prefix: "<rootDir>/" }),
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      { tsconfig: { experimentalDecorators: true, emitDecoratorMetadata: true } },
    ],
  },
  testMatch: ["**/*.spec.ts", "**/*.e2e-spec.ts"],
  testTimeout: 20000,
};
```

- [ ] **Step 4: Add `DATABASE_URL` to `.env.example`**

Add this line under the Postgres section of `.env.example`:
```dotenv
DATABASE_URL=postgresql://flashbite:local_dev_only_change_me@localhost:5432/flashbite_write
```

- [ ] **Step 5: Create the contracts package shell + a sanity test**

Create `packages/contracts/package.json`:
```json
{
  "name": "@flashbite/contracts",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

Create `packages/contracts/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

Create `packages/contracts/src/index.ts` (placeholder, replaced in Task 2):
```ts
export const CONTRACTS_PACKAGE = "@flashbite/contracts";
```

Create `packages/contracts/src/sanity.spec.ts`:
```ts
import { CONTRACTS_PACKAGE } from "@flashbite/contracts";

describe("workspace tooling", () => {
  it("resolves the @flashbite/contracts alias", () => {
    expect(CONTRACTS_PACKAGE).toBe("@flashbite/contracts");
  });
});
```

- [ ] **Step 6: Install and run the sanity test**

Run:
```bash
pnpm install
pnpm test
```
Expected: Jest runs `sanity.spec.ts`, 1 test passes. This proves ts-jest + path aliases + CJS all work before any real code.

- [ ] **Step 7: Commit**

```bash
git add tsconfig.base.json jest.config.cjs package.json .env.example packages/contracts pnpm-lock.yaml
git commit -m "chore(phase-1a): workspace tooling — path aliases, jest, env"
```
End commit body with:
```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 2: contracts package — event envelope + order events

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/contracts.spec.ts`
- Delete: `packages/contracts/src/sanity.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/contracts.spec.ts`:
```ts
import {
  EVENT_TYPES,
  buildEnvelope,
  type OrderPlacedPayload,
} from "@flashbite/contracts";

describe("buildEnvelope", () => {
  const payload: OrderPlacedPayload = {
    orderId: "o-1",
    customerId: "c-1",
    items: [{ sku: "pizza", qty: 1, price: 1200 }],
    totalAmount: 1200,
  };

  it("builds a well-formed envelope", () => {
    const env = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 1,
      payload,
    });

    expect(env.tenantId).toBe("berlin");
    expect(env.eventType).toBe("OrderPlaced");
    expect(env.version).toBe(1);
    expect(env.payload).toEqual(payload);
    expect(env.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new Date(env.occurredAt).toISOString()).not.toThrow();
  });

  it("generates a unique eventId per call", () => {
    const a = buildEnvelope({ tenantId: "berlin", eventType: "X", version: 1, payload });
    const b = buildEnvelope({ tenantId: "berlin", eventType: "X", version: 1, payload });
    expect(a.eventId).not.toBe(b.eventId);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- packages/contracts`
Expected: FAIL — `buildEnvelope`/`EVENT_TYPES`/`OrderPlacedPayload` not exported.

- [ ] **Step 3: Implement the contracts**

Replace `packages/contracts/src/index.ts`:
```ts
import { randomUUID } from "node:crypto";

export interface EventEnvelope<T = unknown> {
  tenantId: string;
  eventId: string;
  eventType: string;
  version: number;
  occurredAt: string;
  payload: T;
}

export interface OrderItem {
  sku: string;
  qty: number;
  price: number;
}

export interface OrderPlacedPayload {
  orderId: string;
  customerId: string;
  items: OrderItem[];
  totalAmount: number;
}

export const EVENT_TYPES = {
  ORDER_PLACED: "OrderPlaced",
} as const;

export const TOPICS = {
  ORDER_EVENTS: "order-events",
} as const;

export function buildEnvelope<T>(args: {
  tenantId: string;
  eventType: string;
  version: number;
  payload: T;
  eventId?: string;
  occurredAt?: string;
}): EventEnvelope<T> {
  return {
    tenantId: args.tenantId,
    eventId: args.eventId ?? randomUUID(),
    eventType: args.eventType,
    version: args.version,
    occurredAt: args.occurredAt ?? new Date().toISOString(),
    payload: args.payload,
  };
}
```

- [ ] **Step 4: Remove the sanity test and run**

```bash
rm packages/contracts/src/sanity.spec.ts
pnpm test -- packages/contracts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): event envelope and order event types"
```
End commit body with the `Co-Authored-By` line.

---

## Task 3: shared package — config + Prisma schema + client

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `packages/shared/prisma/schema.prisma`
- Create: `packages/shared/src/config.ts`, `src/prisma.service.ts`, `src/index.ts`
- Create: `packages/shared/src/config.spec.ts`

- [ ] **Step 1: Create the package + tsconfig**

Create `packages/shared/package.json`:
```json
{
  "name": "@flashbite/shared",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "prisma:generate": "prisma generate --schema prisma/schema.prisma",
    "prisma:migrate": "prisma migrate dev --schema prisma/schema.prisma"
  },
  "dependencies": {
    "@prisma/client": "5.18.0"
  },
  "devDependencies": {
    "prisma": "5.18.0"
  }
}
```

Create `packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: Create the Prisma schema**

Create `packages/shared/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model EventStore {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String   @map("tenant_id")
  aggregateType String   @map("aggregate_type")
  aggregateId   String   @map("aggregate_id")
  version       Int
  eventType     String   @map("event_type")
  payload       Json
  occurredAt    DateTime @default(now()) @map("occurred_at")

  @@unique([tenantId, aggregateId, version])
  @@index([tenantId, aggregateId])
  @@map("event_store")
}

model Outbox {
  id           String   @id @db.Uuid
  tenantId     String   @map("tenant_id")
  topic        String
  partitionKey String   @map("partition_key")
  eventType    String   @map("event_type")
  payload      Json
  status       String   @default("PENDING")
  createdAt    DateTime @default(now()) @map("created_at")

  @@index([status, createdAt])
  @@map("outbox")
}

model ProcessedEvent {
  tenantId    String   @map("tenant_id")
  consumer    String
  eventId     String   @map("event_id") @db.Uuid
  processedAt DateTime @default(now()) @map("processed_at")

  @@id([tenantId, consumer, eventId])
  @@map("processed_events")
}
```

- [ ] **Step 3: Install deps, generate client, run the migration**

```bash
pnpm install
# Prisma reads DATABASE_URL from a .env file at the schema dir or repo root.
# Create the real .env if it doesn't exist (gitignored):
cp -n .env.example .env || true
pnpm --filter @flashbite/shared exec prisma migrate dev --name init_event_store --schema prisma/schema.prisma
```
Expected: migration `init_event_store` created and applied; `event_store`, `outbox`, `processed_events` tables exist in `flashbite_write`. Prisma client generated.

- [ ] **Step 4: Write the failing config test**

Create `packages/shared/src/config.spec.ts`:
```ts
import { loadConfig } from "@flashbite/shared";

describe("loadConfig", () => {
  it("reads database and kafka settings from env with defaults", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      KAFKA_BROKERS: "localhost:9092",
    });
    expect(cfg.databaseUrl).toBe("postgresql://u:p@localhost:5432/db");
    expect(cfg.kafkaBrokers).toEqual(["localhost:9092"]);
    expect(cfg.defaultTenantId).toBe("berlin");
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `pnpm test -- packages/shared`
Expected: FAIL — `loadConfig` not exported.

- [ ] **Step 6: Implement config, prisma service, index**

Create `packages/shared/src/config.ts`:
```ts
export interface AppConfig {
  databaseUrl: string;
  kafkaBrokers: string[];
  defaultTenantId: string;
}

export const DEFAULT_TENANT_ID = "berlin";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return {
    databaseUrl,
    kafkaBrokers: (env.KAFKA_BROKERS ?? "localhost:9092").split(","),
    defaultTenantId: env.DEFAULT_TENANT_ID ?? DEFAULT_TENANT_ID,
  };
}
```

Create `packages/shared/src/prisma.service.ts`:
```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

Create `packages/shared/src/index.ts`:
```ts
export * from "./config";
export * from "./prisma.service";
export { PrismaClient, Prisma } from "@prisma/client";
```

- [ ] **Step 7: Add NestJS as a peer dep of shared and run the test**

Add `@nestjs/common` to `packages/shared/package.json` dependencies (the PrismaService uses its decorators):
```json
    "@prisma/client": "5.18.0",
    "@nestjs/common": "10.4.4"
```
Then:
```bash
pnpm install
pnpm test -- packages/shared
```
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): config loader, prisma schema + service, event store migration"
```
End commit body with the `Co-Authored-By` line.

> Note: the generated Prisma migration under `packages/shared/prisma/migrations/` MUST be committed (it is the source of truth for the schema). Confirm it is staged.

---

## Task 4: tenant-context package

**Files:**
- Create: `packages/tenant-context/package.json`, `tsconfig.json`
- Create: `src/tenant-context.ts`, `src/tenant.middleware.ts`, `src/index.ts`
- Create: `src/tenant-context.spec.ts`

- [ ] **Step 1: Create package + tsconfig**

Create `packages/tenant-context/package.json`:
```json
{
  "name": "@flashbite/tenant-context",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@flashbite/shared": "workspace:*",
    "@nestjs/common": "10.4.4"
  }
}
```

Create `packages/tenant-context/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/tenant-context/src/tenant-context.spec.ts`:
```ts
import {
  runWithTenant,
  getTenantId,
  TenantContextError,
} from "@flashbite/tenant-context";

describe("tenant context", () => {
  it("exposes the tenant id inside the run scope", () => {
    const seen = runWithTenant("berlin", () => getTenantId());
    expect(seen).toBe("berlin");
  });

  it("throws when read outside any scope", () => {
    expect(() => getTenantId()).toThrow(TenantContextError);
  });

  it("isolates nested scopes", () => {
    runWithTenant("berlin", () => {
      const inner = runWithTenant("tokyo", () => getTenantId());
      expect(inner).toBe("tokyo");
      expect(getTenantId()).toBe("berlin");
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test -- packages/tenant-context`
Expected: FAIL — exports missing.

- [ ] **Step 4: Implement the context + middleware**

Create `packages/tenant-context/src/tenant-context.ts`:
```ts
import { AsyncLocalStorage } from "node:async_hooks";

export class TenantContextError extends Error {}

const storage = new AsyncLocalStorage<{ tenantId: string }>();

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

export function getTenantId(): string {
  const store = storage.getStore();
  if (!store) {
    throw new TenantContextError("No tenant context in scope");
  }
  return store.tenantId;
}
```

Create `packages/tenant-context/src/tenant.middleware.ts`:
```ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { DEFAULT_TENANT_ID } from "@flashbite/shared";
import { runWithTenant } from "./tenant-context";

/**
 * Phase 1: hardcoded single tenant. Reads X-Tenant-ID if present, otherwise
 * falls back to DEFAULT_TENANT_ID. Phase 2 replaces this with verified-JWT
 * tenant resolution (master spec §3.3 / §3.5).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const tenantId = (req.headers["x-tenant-id"] as string) || DEFAULT_TENANT_ID;
    runWithTenant(tenantId, () => next());
  }
}
```

Create `packages/tenant-context/src/index.ts`:
```ts
export * from "./tenant-context";
export * from "./tenant.middleware";
```

- [ ] **Step 5: Install + run**

```bash
pnpm install
pnpm test -- packages/tenant-context
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/tenant-context
git commit -m "feat(tenant-context): AsyncLocalStorage tenant scope + nest middleware"
```
End commit body with the `Co-Authored-By` line.

---

## Task 5: write-api — bootstrap, health, tenant middleware

**Files:**
- Create: `apps/write-api/package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`
- Create: `src/main.ts`, `src/app.module.ts`, `src/health.controller.ts`
- Create: `test/health.e2e-spec.ts`

- [ ] **Step 1: Create the app manifest + configs**

Create `apps/write-api/package.json`:
```json
{
  "name": "@flashbite/write-api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "start": "nest start -r tsconfig-paths/register",
    "start:dev": "nest start --watch -r tsconfig-paths/register",
    "build": "nest build"
  },
  "dependencies": {
    "@flashbite/contracts": "workspace:*",
    "@flashbite/shared": "workspace:*",
    "@flashbite/tenant-context": "workspace:*",
    "@nestjs/common": "10.4.4",
    "@nestjs/core": "10.4.4",
    "@nestjs/platform-express": "10.4.4",
    "class-transformer": "0.5.1",
    "class-validator": "0.14.1",
    "reflect-metadata": "0.2.2",
    "rxjs": "7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "10.4.4",
    "@nestjs/testing": "10.4.4",
    "@nestjs/schematics": "10.1.4",
    "supertest": "7.0.0",
    "@types/supertest": "6.0.2"
  }
}
```

Create `apps/write-api/nest-cli.json`:
```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "tsConfigPath": "tsconfig.build.json"
  }
}
```

Create `apps/write-api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "target": "ES2021",
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `apps/write-api/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "test", "**/*.spec.ts", "**/*.e2e-spec.ts"]
}
```

- [ ] **Step 2: Write the failing e2e test**

Create `apps/write-api/test/health.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("write-api health (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns ok with the resolved tenant", async () => {
    const res = await request(app.getHttpServer())
      .get("/health")
      .set("X-Tenant-ID", "berlin");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", tenantId: "berlin" });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm install && pnpm test -- apps/write-api/test/health.e2e-spec.ts`
Expected: FAIL — `AppModule` does not exist.

- [ ] **Step 4: Implement bootstrap, module, health controller**

Create `apps/write-api/src/health.controller.ts`:
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

Create `apps/write-api/src/app.module.ts`:
```ts
import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { TenantMiddleware } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";

@Module({
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
```

Create `apps/write-api/src/main.ts`:
```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.WRITE_API_PORT ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`write-api listening on ${port}`);
}

bootstrap();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- apps/write-api/test/health.e2e-spec.ts`
Expected: PASS — `{ status: "ok", tenantId: "berlin" }`.

- [ ] **Step 6: Commit**

```bash
git add apps/write-api pnpm-lock.yaml
git commit -m "feat(write-api): nest bootstrap, health endpoint, tenant middleware"
```
End commit body with the `Co-Authored-By` line.

---

## Task 6: write-api — CreateOrder (atomic event + outbox, idempotent)

**Files:**
- Create: `apps/write-api/src/orders/create-order.dto.ts`
- Create: `apps/write-api/src/orders/orders.service.ts`
- Create: `apps/write-api/src/orders/orders.controller.ts`
- Create: `apps/write-api/src/orders/orders.module.ts`
- Modify: `apps/write-api/src/app.module.ts` (import OrdersModule)
- Create: `apps/write-api/test/orders.e2e-spec.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `apps/write-api/test/orders.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@flashbite/shared";

describe("write-api orders (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const body = (orderId: string) => ({
    orderId,
    customerId: "c-1",
    items: [{ sku: "pizza", qty: 1, price: 1200 }],
    totalAmount: 1200,
  });

  it("writes an event_store row and a PENDING outbox row atomically", async () => {
    const orderId = randomUUID();
    const res = await request(app.getHttpServer())
      .post("/orders")
      .set("X-Tenant-ID", "berlin")
      .send(body(orderId));

    expect(res.status).toBe(201);
    expect(res.body.orderId).toBe(orderId);

    const events = await prisma.eventStore.findMany({
      where: { tenantId: "berlin", aggregateId: orderId },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("OrderPlaced");

    const outbox = await prisma.outbox.findMany({
      where: { tenantId: "berlin", partitionKey: `berlin:${orderId}` },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe("PENDING");
    expect(outbox[0].topic).toBe("order-events");
  });

  it("is idempotent — re-posting the same orderId does not duplicate", async () => {
    const orderId = randomUUID();
    await request(app.getHttpServer()).post("/orders").set("X-Tenant-ID", "berlin").send(body(orderId));
    const res2 = await request(app.getHttpServer())
      .post("/orders")
      .set("X-Tenant-ID", "berlin")
      .send(body(orderId));

    expect(res2.status).toBe(201);
    const events = await prisma.eventStore.findMany({
      where: { tenantId: "berlin", aggregateId: orderId },
    });
    expect(events).toHaveLength(1);
    const outbox = await prisma.outbox.findMany({
      where: { tenantId: "berlin", partitionKey: `berlin:${orderId}` },
    });
    expect(outbox).toHaveLength(1);
  });

  it("rejects an invalid payload with 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/orders")
      .set("X-Tenant-ID", "berlin")
      .send({ orderId: "not-much" });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- apps/write-api/test/orders.e2e-spec.ts`
Expected: FAIL — `POST /orders` 404 (route not defined).

- [ ] **Step 3: Implement the DTO**

Create `apps/write-api/src/orders/create-order.dto.ts`:
```ts
import { Type } from "class-transformer";
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";

export class OrderItemDto {
  @IsString() sku!: string;
  @IsInt() @Min(1) qty!: number;
  @IsInt() @Min(0) price!: number;
}

export class CreateOrderDto {
  @IsString() orderId!: string;
  @IsString() customerId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @IsInt() @Min(0) totalAmount!: number;
}
```

- [ ] **Step 4: Implement the service (atomic write + idempotency)**

Create `apps/write-api/src/orders/orders.service.ts`:
```ts
import { Injectable } from "@nestjs/common";
import { PrismaService, Prisma } from "@flashbite/shared";
import { getTenantId } from "@flashbite/tenant-context";
import {
  EVENT_TYPES,
  TOPICS,
  buildEnvelope,
  type OrderPlacedPayload,
} from "@flashbite/contracts";
import { CreateOrderDto } from "./create-order.dto";

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async placeOrder(dto: CreateOrderDto): Promise<{ orderId: string }> {
    const tenantId = getTenantId();
    const payload: OrderPlacedPayload = {
      orderId: dto.orderId,
      customerId: dto.customerId,
      items: dto.items,
      totalAmount: dto.totalAmount,
    };
    const envelope = buildEnvelope({
      tenantId,
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 1,
      payload,
    });

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.eventStore.create({
          data: {
            id: envelope.eventId,
            tenantId,
            aggregateType: "ORDER",
            aggregateId: dto.orderId,
            version: 1,
            eventType: EVENT_TYPES.ORDER_PLACED,
            payload: payload as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.outbox.create({
          data: {
            id: envelope.eventId,
            tenantId,
            topic: TOPICS.ORDER_EVENTS,
            partitionKey: `${tenantId}:${dto.orderId}`,
            eventType: EVENT_TYPES.ORDER_PLACED,
            payload: envelope as unknown as Prisma.InputJsonValue,
          },
        });
      });
    } catch (err) {
      // Idempotency: a duplicate (tenantId, aggregateId, version) means this
      // order was already placed. Collapse to the original — no duplicate event.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return { orderId: dto.orderId };
      }
      throw err;
    }

    return { orderId: dto.orderId };
  }
}
```

- [ ] **Step 5: Implement the controller + module, wire into AppModule**

Create `apps/write-api/src/orders/orders.controller.ts`:
```ts
import { Body, Controller, Post } from "@nestjs/common";
import { CreateOrderDto } from "./create-order.dto";
import { OrdersService } from "./orders.service";

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  place(@Body() dto: CreateOrderDto): Promise<{ orderId: string }> {
    return this.orders.placeOrder(dto);
  }
}
```

Create `apps/write-api/src/orders/orders.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { PrismaService } from "@flashbite/shared";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, PrismaService],
})
export class OrdersModule {}
```

Replace `apps/write-api/src/app.module.ts` (add OrdersModule, keep middleware):
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

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test -- apps/write-api/test/orders.e2e-spec.ts`
Expected: PASS (3 tests) — atomic write, idempotency, validation.

- [ ] **Step 7: Commit**

```bash
git add apps/write-api
git commit -m "feat(write-api): CreateOrder with atomic event+outbox write and idempotency"
```
End commit body with the `Co-Authored-By` line.

---

## Task 7: outbox-poller — relay PENDING rows to Redpanda

**Files:**
- Create: `apps/outbox-poller/package.json`, `tsconfig.json`
- Create: `src/poller.ts`, `src/main.ts`
- Create: `test/poller.spec.ts`

- [ ] **Step 1: Create the app manifest + tsconfig**

Create `apps/outbox-poller/package.json`:
```json
{
  "name": "@flashbite/outbox-poller",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "start": "tsx -r tsconfig-paths/register src/main.ts"
  },
  "dependencies": {
    "@flashbite/contracts": "workspace:*",
    "@flashbite/shared": "workspace:*",
    "kafkajs": "2.2.4"
  }
}
```

Create `apps/outbox-poller/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/outbox-poller/test/poller.spec.ts`:
```ts
import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { PrismaService } from "@flashbite/shared";
import { buildEnvelope, EVENT_TYPES, TOPICS } from "@flashbite/contracts";
import { pollOnce } from "../src/poller";

describe("outbox poller", () => {
  const prisma = new PrismaService();
  const kafka = new Kafka({ clientId: "poller-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("publishes PENDING rows and marks them SENT", async () => {
    const orderId = randomUUID();
    const eventId = randomUUID();
    const envelope = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 1,
      eventId,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: 0 },
    });
    await prisma.outbox.create({
      data: {
        id: eventId,
        tenantId: "berlin",
        topic: TOPICS.ORDER_EVENTS,
        partitionKey: `berlin:${orderId}`,
        eventType: EVENT_TYPES.ORDER_PLACED,
        payload: envelope as never,
      },
    });

    // Capture the high-water mark, then poll.
    const admin = kafka.admin();
    await admin.connect();
    const before = await admin.fetchTopicOffsets(TOPICS.ORDER_EVENTS);
    await admin.disconnect();
    const startOffsets = new Map(before.map((w) => [w.partition, BigInt(w.high)]));

    const producer = kafka.producer();
    await producer.connect();
    const count = await pollOnce(prisma, producer);
    await producer.disconnect();
    expect(count).toBeGreaterThanOrEqual(1);

    const row = await prisma.outbox.findUnique({ where: { id: eventId } });
    expect(row?.status).toBe("SENT");

    // Confirm our event reached the topic.
    const consumer = kafka.consumer({ groupId: `poller-test-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: true });
    const received: string = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("event not received")), 10000);
      consumer.on(consumer.events.GROUP_JOIN, () => {
        for (const [p, o] of startOffsets) consumer.seek({ topic: TOPICS.ORDER_EVENTS, partition: p, offset: o.toString() });
      });
      consumer
        .run({
          eachMessage: async ({ partition, message }) => {
            if (BigInt(message.offset) < (startOffsets.get(partition) ?? 0n)) return;
            const value = JSON.parse(message.value!.toString());
            if (value.eventId === eventId) {
              clearTimeout(timer);
              resolve(value.eventId);
            }
          },
        })
        .catch(reject);
    });
    await consumer.disconnect();
    expect(received).toBe(eventId);

    await prisma.outbox.delete({ where: { id: eventId } });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm install && pnpm test -- apps/outbox-poller/test/poller.spec.ts`
Expected: FAIL — `pollOnce` not exported.

- [ ] **Step 4: Implement the poller**

Create `apps/outbox-poller/src/poller.ts`:
```ts
import type { Producer } from "kafkajs";
import type { PrismaService } from "@flashbite/shared";

/**
 * Publishes all PENDING outbox rows (oldest first) to Kafka and marks them SENT.
 * At-least-once: a row may publish more than once on crash between send and
 * update — consumers dedupe on the envelope eventId. Returns the number sent.
 */
export async function pollOnce(prisma: PrismaService, producer: Producer): Promise<number> {
  const pending = await prisma.outbox.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  for (const row of pending) {
    await producer.send({
      topic: row.topic,
      messages: [{ key: row.partitionKey, value: JSON.stringify(row.payload) }],
    });
    await prisma.outbox.update({ where: { id: row.id }, data: { status: "SENT" } });
  }

  return pending.length;
}
```

Create `apps/outbox-poller/src/main.ts`:
```ts
import { Kafka, logLevel } from "kafkajs";
import { PrismaService, loadConfig } from "@flashbite/shared";
import { pollOnce } from "./poller";

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000);

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = new PrismaService();
  await prisma.$connect();

  const kafka = new Kafka({
    clientId: "outbox-poller",
    brokers: config.kafkaBrokers,
    logLevel: logLevel.NOTHING,
  });
  const producer = kafka.producer();
  await producer.connect();

  // eslint-disable-next-line no-console
  console.log("outbox-poller running");
  let running = true;
  const shutdown = async (): Promise<void> => {
    running = false;
    await producer.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    const sent = await pollOnce(prisma, producer);
    if (sent === 0) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- apps/outbox-poller/test/poller.spec.ts`
Expected: PASS — row marked SENT and the envelope received on `order-events`.

- [ ] **Step 6: Commit**

```bash
git add apps/outbox-poller pnpm-lock.yaml
git commit -m "feat(outbox-poller): relay PENDING outbox rows to redpanda as JSON envelopes"
```
End commit body with the `Co-Authored-By` line.

---

## Task 8: End-to-end 1a verification + run scripts

**Files:**
- Modify: root `package.json` (add `dev:write-api`, `dev:outbox` convenience scripts)
- Create: `docs/superpowers/plans/phase-1a-verification.md` (the manual run recipe)

- [ ] **Step 1: Add convenience scripts**

Update the root `package.json` `scripts` block to add (keep all existing scripts):
```json
    "test": "jest",
    "dev:write-api": "pnpm --filter @flashbite/write-api start",
    "dev:outbox": "pnpm --filter @flashbite/outbox-poller start"
```

- [ ] **Step 2: Run the full 1a test suite**

Run (infra must be up):
```bash
pnpm infra:up
pnpm test
```
Expected: all suites pass — contracts (2), shared config (2), tenant-context (3), write-api health (1), write-api orders (3), outbox-poller (1).

- [ ] **Step 3: Manual end-to-end check (command plane runs live)**

In terminal 1: `pnpm dev:write-api` (wait for "write-api listening on 3001").
In terminal 2: `pnpm dev:outbox` (wait for "outbox-poller running").
In terminal 3, place an order and watch it reach Kafka:
```bash
ORDER_ID=$(uuidgen)
curl -s -XPOST localhost:3001/orders -H 'Content-Type: application/json' -H 'X-Tenant-ID: berlin' \
  -d "{\"orderId\":\"$ORDER_ID\",\"customerId\":\"c-1\",\"items\":[{\"sku\":\"pizza\",\"qty\":1,\"price\":1200}],\"totalAmount\":1200}"
# Then confirm the message landed (use the Phase 0 host redis-cli equivalent for kafka):
docker exec $(docker compose -f infra/docker-compose.yml ps -q redpanda) \
  rpk topic consume order-events --brokers redpanda:29092 --num 1 --offset end:1
```
Expected: the curl returns `{"orderId":"<id>"}`; the outbox-poller relays it; the consumed message is the JSON envelope with that `eventId` and `payload.orderId`. Stop both dev processes afterward.

- [ ] **Step 4: Write the verification recipe doc**

Create `docs/superpowers/plans/phase-1a-verification.md`:
```markdown
# Phase 1a — Verification

Prereq: `pnpm infra:up`.

## Automated
`pnpm test` — contracts, shared, tenant-context, write-api (health + orders), outbox-poller.

## Manual end-to-end (command plane)
1. `pnpm dev:write-api`  (port 3001)
2. `pnpm dev:outbox`
3. POST an order to `/orders` with header `X-Tenant-ID: berlin`.
4. Confirm: one `event_store` row, one `outbox` row that flips PENDING -> SENT,
   and the JSON envelope appears on the `order-events` topic.
5. Re-POST the same `orderId` -> still one event, one outbox row (idempotent).

Phase 1b consumes these `order-events` into Mongo read models.
```

- [ ] **Step 5: Commit**

```bash
git add package.json docs/superpowers/plans/phase-1a-verification.md
git commit -m "docs(phase-1a): run scripts and end-to-end verification recipe"
```
End commit body with the `Co-Authored-By` line.

---

## Self-Review (completed by plan author)

**Spec coverage (master spec §6 Phase 1, command-plane slice):**
- "write-api: CreateOrder → atomic event store + outbox write with idempotency key" → Task 6. ✓
- "outbox-poller (→ Kafka JSON)" → Task 7. ✓
- "JSON on the wire (not Avro yet)" → envelope stored/published as JSON (Tasks 2, 6, 7). ✓
- "Idempotency keys + the inbox table go in now" → `processed_events` table created in Task 3; idempotent create in Task 6 (the inbox is *consumed* in Phase 1b's projection-worker, but the table is provisioned here as specified). ✓
- "one hardcoded tenant" → `DEFAULT_TENANT_ID = "berlin"`, tenant middleware (Tasks 3, 4). ✓
- Tenant context spine (§3.3) → `tenant-context` package + middleware (Task 4), consumed by write-api (Tasks 5, 6). ✓
- Partition key `tenantId:orderId` (§3.2/§4) → set on the outbox row and used as the Kafka message key (Tasks 6, 7). ✓
- Event envelope shape (§3.4) → `EventEnvelope` in contracts (Task 2). ✓

**Placeholder scan:** No TBD/TODO. Every code/command step has complete content.

**Type/name consistency:** `buildEnvelope`, `EventEnvelope`, `OrderPlacedPayload`, `EVENT_TYPES.ORDER_PLACED` ("OrderPlaced"), `TOPICS.ORDER_EVENTS` ("order-events"), `DEFAULT_TENANT_ID` ("berlin"), `getTenantId`/`runWithTenant`/`TenantMiddleware`, `PrismaService`, `pollOnce(prisma, producer)`, and the Prisma models (`eventStore`/`outbox`/`processedEvent` → tables `event_store`/`outbox`/`processed_events`) are used identically across every task. The outbox `id` equals the envelope `eventId` in both the writer (Task 6) and the poller test (Task 7), so consumer-side dedup in Phase 1b will key correctly.

**Scope note:** This sub-plan delivers only the command plane (write side → Kafka). Consuming `order-events` into Mongo read models + SSE is Phase 1b; the Temporal saga is Phase 1c; frontends are Phase 1d. The `processed_events` inbox table is created here but first used in 1b.
```
