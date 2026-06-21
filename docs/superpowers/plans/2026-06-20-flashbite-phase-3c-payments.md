# Phase 3c — Real Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake `charge`/`refund` saga activities with a real self-built `payments` service driving an authorize → capture/void lifecycle, with idempotent ops, a persisted ledger, and a deterministic decline that cancels the order with `PAYMENT_FAILED`.

**Architecture:** A new NestJS `payments` service (`:3004`) owns its own `flashbite_payments` Postgres DB (its own Prisma schema, generated to a custom output to avoid clashing with the shared client). The saga calls it synchronously over HTTP from Temporal activities; a declined authorize short-circuits to `OrderCancelled(PAYMENT_FAILED)`. The Order aggregate/event store are unchanged.

**Tech Stack:** NestJS 10, Prisma 5.18 (second client, custom output), Postgres, Temporal, Jest/ts-jest + supertest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-20-flashbite-phase-3c-payments-design.md`

---

## Conventions (read once)

- Host Postgres is on **port 5434** (`postgres` container maps `5434:5432`). The app DB is `flashbite_write`; payments adds `flashbite_payments` in the **same** container.
- Tests run with `pnpm jest <path>` from repo root; e2e need `pnpm infra:up`. The saga payment e2e additionally needs the **payments service running** (`pnpm dev:payments`) — same as how suites already need infra up.
- New NestJS apps follow `apps/identity` (package.json, `tsconfig.json` extending `../../tsconfig.base.json` with `module: commonjs`, `nest-cli.json`, `tsconfig.build.json`, `src/main.ts`, `health.controller.ts`).
- Amounts are integers in the same unit as order `totalAmount` (e.g. `1200`). `AUTH_DECLINE_THRESHOLD` default **100000** — existing test orders (`1200`) authorize; a `>= 100000` order declines.
- Do **not** read or modify `.env` (only `.env.example`). Never print secrets.

---

## Task 1: Contracts + shared config

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/shared/src/config.ts`
- Create: `packages/contracts/src/payments.spec.ts`

- [ ] **Step 1: Write the failing test `packages/contracts/src/payments.spec.ts`**

```ts
import { ORDER_CANCEL_REASONS, ORDER_SAGA_RESULTS, PAYMENT_STATUS } from "./index";

describe("payment contracts", () => {
  it("adds the payment-failed cancel reason and saga result", () => {
    expect(ORDER_CANCEL_REASONS.PAYMENT_FAILED).toBe("PAYMENT_FAILED");
    expect(ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_FAILED).toBe("CANCELLED_PAYMENT_FAILED");
  });

  it("exposes the payment ledger statuses", () => {
    expect(PAYMENT_STATUS).toEqual({
      AUTHORIZED: "AUTHORIZED",
      CAPTURED: "CAPTURED",
      VOIDED: "VOIDED",
      DECLINED: "DECLINED",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest packages/contracts/src/payments.spec.ts`
Expected: FAIL — `PAYMENT_FAILED` / `CANCELLED_PAYMENT_FAILED` / `PAYMENT_STATUS` not exported.

- [ ] **Step 3: Edit `packages/contracts/src/index.ts`**

In `ORDER_CANCEL_REASONS`, add the `PAYMENT_FAILED` entry:

```ts
export const ORDER_CANCEL_REASONS = {
  SLA_BREACH: "SLA_BREACH",
  DECLINED: "DECLINED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
} as const;
```

In `ORDER_SAGA_RESULTS`, add the `CANCELLED_PAYMENT_FAILED` entry:

```ts
export const ORDER_SAGA_RESULTS = {
  ACCEPTED: "ACCEPTED",
  CANCELLED_SLA: "CANCELLED_SLA",
  CANCELLED_DECLINED: "CANCELLED_DECLINED",
  CANCELLED_PAYMENT_FAILED: "CANCELLED_PAYMENT_FAILED",
} as const;
```

At the end of the file, add a payments section (pure types/constants — no runtime deps):

```ts
// ---- Payments (Phase 3c) ----
export const PAYMENT_STATUS = {
  AUTHORIZED: "AUTHORIZED",
  CAPTURED: "CAPTURED",
  VOIDED: "VOIDED",
  DECLINED: "DECLINED",
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

/** Request bodies the saga sends to the payments service. */
export interface AuthorizePaymentRequest {
  tenantId: string;
  orderId: string;
  amount: number;
  idempotencyKey: string;
}
export interface CaptureVoidRequest {
  tenantId: string;
  orderId: string;
  idempotencyKey: string;
}

/** Response from authorize/capture/void. `outcome` is the lowercase result word. */
export interface PaymentResponse {
  paymentId: string;
  outcome: "authorized" | "declined" | "captured" | "voided";
}
```

- [ ] **Step 4: Add `paymentsUrl` to `packages/shared/src/config.ts`**

In `interface AppConfig`, after `schemaRegistryUrl`:

```ts
  paymentsUrl: string;
```

In the `loadConfig` return object, after `schemaRegistryUrl`:

```ts
    paymentsUrl: env.PAYMENTS_URL ?? "http://localhost:3004",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm jest packages/contracts/src/payments.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck both packages**

Run: `pnpm exec tsc -p packages/contracts/tsconfig.json --noEmit && pnpm exec tsc -p packages/shared/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/payments.spec.ts packages/shared/src/config.ts
git commit -m "feat(contracts,shared): payment cancel reason + saga result + DTO types + paymentsUrl"
```

---

## Task 2: Infra — `flashbite_payments` DB + env + root scripts

**Files:**
- Create: `infra/postgres-init/01-create-payments-db.sql`
- Modify: `infra/docker-compose.yml` (mount init dir on `postgres`)
- Modify: `infra/docker-compose.ci.yml` (mount init dir on `postgres`)
- Modify: `.env.example`
- Modify: `package.json` (root scripts)

- [ ] **Step 1: Create `infra/postgres-init/01-create-payments-db.sql`**

```sql
-- Runs once on first init of an empty Postgres data dir (docker-entrypoint-initdb.d).
-- Creates the payments bounded-context database alongside flashbite_write.
CREATE DATABASE flashbite_payments;
```

- [ ] **Step 2: Mount the init dir on the `postgres` service in `infra/docker-compose.yml`**

In the `postgres:` service, add the init mount to its `volumes:` list (keep the existing `pg_app_data` volume):

```yaml
    volumes:
      - pg_app_data:/var/lib/postgresql/data
      - ./postgres-init:/docker-entrypoint-initdb.d:ro
```

- [ ] **Step 3: Mount the init dir on the `postgres` service in `infra/docker-compose.ci.yml`**

Find the `postgres:` service and add (matching its existing structure):

```yaml
    volumes:
      - ./postgres-init:/docker-entrypoint-initdb.d:ro
```

(If the CI postgres has no `volumes:` key yet, add one with just this entry.)

- [ ] **Step 4: Add env vars to `.env.example`**

Near the `DATABASE_URL` / `APP_DATABASE_URL` block, add:

```
# Phase 3c payments service (own bounded-context DB in the same Postgres container)
PAYMENTS_URL=http://localhost:3004
PAYMENTS_DATABASE_URL=postgresql://flashbite:local_dev_only_change_me@localhost:5434/flashbite_payments
# Orders with totalAmount >= this are declined by the payment gateway (demo/test trigger)
AUTH_DECLINE_THRESHOLD=100000
```

- [ ] **Step 5: Add root `package.json` scripts**

In `scripts`, add (after `dev:identity`):

```json
"dev:payments": "node -r @swc-node/register -r tsconfig-paths/register --env-file=.env apps/payments/src/main.ts",
```

After `db:setup`, add the payments DB scripts:

```json
"payments:db:create": "docker compose -f infra/docker-compose.yml exec -T postgres psql -U flashbite -d flashbite_write -c \"CREATE DATABASE flashbite_payments\" || true",
"payments:generate": "node packages/shared/node_modules/prisma/build/index.js generate --schema apps/payments/prisma/schema.prisma",
"payments:db:deploy": "node --env-file=.env packages/shared/node_modules/prisma/build/index.js migrate deploy --schema apps/payments/prisma/schema.prisma"
```

> `payments:db:create` is for existing dev volumes (the init SQL only runs on a fresh volume / in CI).
> It is idempotent-ish via `|| true` (CREATE DATABASE errors if it already exists; that's fine).

- [ ] **Step 6: Verify compose files still parse**

Run: `docker compose -f infra/docker-compose.yml config -q && docker compose -f infra/docker-compose.ci.yml config -q && echo "compose OK"`
Expected: `compose OK`.

- [ ] **Step 7: Commit**

```bash
git add infra/postgres-init infra/docker-compose.yml infra/docker-compose.ci.yml .env.example package.json
git commit -m "infra(payments): flashbite_payments DB init + env + dev/db scripts"
```

---

## Task 3: Scaffold `apps/payments` (NestJS) + Prisma schema

**Files:**
- Create: `apps/payments/package.json`, `apps/payments/tsconfig.json`, `apps/payments/tsconfig.build.json`, `apps/payments/nest-cli.json`
- Create: `apps/payments/prisma/schema.prisma`
- Create: `apps/payments/src/main.ts`, `apps/payments/src/health.controller.ts`, `apps/payments/src/app.module.ts`
- Modify: `.gitignore` (ignore the generated client)

- [ ] **Step 1: `apps/payments/package.json`**

```json
{
  "name": "@flashbite/payments",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "start": "node -r @swc-node/register -r tsconfig-paths/register src/main.ts"
  },
  "dependencies": {
    "@flashbite/contracts": "workspace:*",
    "@nestjs/common": "10.4.4",
    "@nestjs/core": "10.4.4",
    "@nestjs/platform-express": "10.4.4",
    "@prisma/client": "5.18.0",
    "class-transformer": "0.5.1",
    "class-validator": "0.14.1",
    "reflect-metadata": "0.2.2",
    "rxjs": "7.8.1"
  },
  "devDependencies": {
    "@nestjs/testing": "10.4.4",
    "@types/supertest": "6.0.2",
    "prisma": "5.18.0",
    "supertest": "7.0.0"
  }
}
```

- [ ] **Step 2: `apps/payments/tsconfig.json`** (copy of identity's)

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

- [ ] **Step 3: `apps/payments/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "test", "**/*.spec.ts", "**/*.e2e-spec.ts"]
}
```

- [ ] **Step 4: `apps/payments/nest-cli.json`**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true, "tsConfigPath": "tsconfig.build.json" }
}
```

- [ ] **Step 5: `apps/payments/prisma/schema.prisma`** (own DB + custom output)

```prisma
generator client {
  provider = "prisma-client-js"
  output   = "./generated"
}

datasource db {
  provider = "postgresql"
  url      = env("PAYMENTS_DATABASE_URL")
}

model Payment {
  id           String    @id @default(uuid()) @db.Uuid
  tenantId     String    @map("tenant_id")
  orderId      String    @map("order_id")
  amount       Int
  status       String // AUTHORIZED | CAPTURED | VOIDED | DECLINED
  authorizedAt DateTime? @map("authorized_at")
  capturedAt   DateTime? @map("captured_at")
  voidedAt     DateTime? @map("voided_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  @@unique([tenantId, orderId])
  @@map("payment")
}
```

- [ ] **Step 6: Ignore the generated client in `.gitignore`**

Append:

```
apps/payments/prisma/generated/
```

- [ ] **Step 7: `apps/payments/src/health.controller.ts`**

```ts
import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: "ok" };
  }
}
```

- [ ] **Step 8: `apps/payments/src/app.module.ts`** (PaymentsModule added in Task 6 — for now just health)

```ts
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

@Module({
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 9: `apps/payments/src/main.ts`**

```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.PAYMENTS_PORT ?? 3004);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`payments listening on ${port}`);
}

bootstrap();
```

- [ ] **Step 10: Install + generate the payments Prisma client**

Run: `pnpm install`
Run: `pnpm payments:generate`
Expected: generates `apps/payments/prisma/generated/` (Prisma client). No errors.

- [ ] **Step 11: Typecheck**

Run: `pnpm exec tsc -p apps/payments/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/payments .gitignore pnpm-lock.yaml
git commit -m "feat(payments): scaffold NestJS payments service + own Prisma schema"
```

---

## Task 4: Payment decision rules (pure) + unit test

**Files:**
- Create: `apps/payments/src/payment-rules.ts`
- Create: `apps/payments/test/payment-rules.spec.ts`

- [ ] **Step 1: Write the failing test `apps/payments/test/payment-rules.spec.ts`**

```ts
import { PAYMENT_STATUS } from "@flashbite/contracts";
import { decideAuthorize, nextOnCapture, nextOnVoid, IllegalTransitionError } from "../src/payment-rules";

describe("payment rules", () => {
  it("declines at or above the threshold, authorizes below", () => {
    expect(decideAuthorize(99999, 100000)).toBe(PAYMENT_STATUS.AUTHORIZED);
    expect(decideAuthorize(100000, 100000)).toBe(PAYMENT_STATUS.DECLINED);
  });

  it("capture: AUTHORIZED -> CAPTURED, CAPTURED is idempotent, others illegal", () => {
    expect(nextOnCapture(PAYMENT_STATUS.AUTHORIZED)).toBe(PAYMENT_STATUS.CAPTURED);
    expect(nextOnCapture(PAYMENT_STATUS.CAPTURED)).toBe(PAYMENT_STATUS.CAPTURED);
    expect(() => nextOnCapture(PAYMENT_STATUS.VOIDED)).toThrow(IllegalTransitionError);
    expect(() => nextOnCapture(PAYMENT_STATUS.DECLINED)).toThrow(IllegalTransitionError);
  });

  it("void: AUTHORIZED -> VOIDED, VOIDED is idempotent, others illegal", () => {
    expect(nextOnVoid(PAYMENT_STATUS.AUTHORIZED)).toBe(PAYMENT_STATUS.VOIDED);
    expect(nextOnVoid(PAYMENT_STATUS.VOIDED)).toBe(PAYMENT_STATUS.VOIDED);
    expect(() => nextOnVoid(PAYMENT_STATUS.CAPTURED)).toThrow(IllegalTransitionError);
    expect(() => nextOnVoid(PAYMENT_STATUS.DECLINED)).toThrow(IllegalTransitionError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest apps/payments/test/payment-rules.spec.ts`
Expected: FAIL — module `../src/payment-rules` not found.

- [ ] **Step 3: Implement `apps/payments/src/payment-rules.ts`**

```ts
import { PAYMENT_STATUS, type PaymentStatus } from "@flashbite/contracts";

/** Thrown when a capture/void is attempted from a state that forbids it. */
export class IllegalTransitionError extends Error {
  constructor(from: PaymentStatus, op: string) {
    super(`Cannot ${op} a payment in status ${from}`);
    this.name = "IllegalTransitionError";
  }
}

/** Deterministic gateway decision: decline at/above the threshold. */
export function decideAuthorize(amount: number, declineThreshold: number): PaymentStatus {
  return amount >= declineThreshold ? PAYMENT_STATUS.DECLINED : PAYMENT_STATUS.AUTHORIZED;
}

/** AUTHORIZED -> CAPTURED. Re-capturing a CAPTURED payment is idempotent. */
export function nextOnCapture(current: PaymentStatus): PaymentStatus {
  if (current === PAYMENT_STATUS.CAPTURED) return PAYMENT_STATUS.CAPTURED;
  if (current === PAYMENT_STATUS.AUTHORIZED) return PAYMENT_STATUS.CAPTURED;
  throw new IllegalTransitionError(current, "capture");
}

/** AUTHORIZED -> VOIDED. Re-voiding a VOIDED payment is idempotent. */
export function nextOnVoid(current: PaymentStatus): PaymentStatus {
  if (current === PAYMENT_STATUS.VOIDED) return PAYMENT_STATUS.VOIDED;
  if (current === PAYMENT_STATUS.AUTHORIZED) return PAYMENT_STATUS.VOIDED;
  throw new IllegalTransitionError(current, "void");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm jest apps/payments/test/payment-rules.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/payments/src/payment-rules.ts apps/payments/test/payment-rules.spec.ts
git commit -m "feat(payments): pure decision rules (decline threshold + capture/void transitions)"
```

---

## Task 5: PaymentsService (Prisma persistence) + live e2e

**Files:**
- Create: `apps/payments/src/payments-prisma.service.ts`
- Create: `apps/payments/src/payments.service.ts`
- Create: `apps/payments/test/payments.service.e2e-spec.ts`

Requires: `pnpm infra:up` + `flashbite_payments` exists + `pnpm payments:generate` + `pnpm payments:db:deploy` (Step 2 creates the migration; run deploy after).

- [ ] **Step 1: `apps/payments/src/payments-prisma.service.ts`** (the payments-owned Prisma client)

```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "../prisma/generated";

@Injectable()
export class PaymentsPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

- [ ] **Step 2: Create the payments migration + apply it**

Run: `pnpm payments:generate`
Run: `node --env-file=.env packages/shared/node_modules/prisma/build/index.js migrate dev --name init_payment --schema apps/payments/prisma/schema.prisma`
Expected: creates `apps/payments/prisma/migrations/<ts>_init_payment/` and the `payment` table in `flashbite_payments`.

(If `migrate dev` is not desired in CI/non-interactive contexts, the committed migration + `pnpm payments:db:deploy` applies it.)

- [ ] **Step 3: Write the failing e2e `apps/payments/test/payments.service.e2e-spec.ts`**

```ts
import { randomUUID } from "node:crypto";
import { PaymentsPrismaService } from "../src/payments-prisma.service";
import { PaymentsService } from "../src/payments.service";
import { PAYMENT_STATUS } from "@flashbite/contracts";

describe("PaymentsService (live flashbite_payments)", () => {
  const prisma = new PaymentsPrismaService();
  const svc = new PaymentsService(prisma);
  const THRESHOLD = 100000;
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });

  function ids() { return { tenantId: "berlin", orderId: randomUUID() }; }
  async function cleanup(orderId: string) { await prisma.payment.deleteMany({ where: { orderId } }); }

  it("authorizes below the threshold (idempotent)", async () => {
    const { tenantId, orderId } = ids();
    const a = await svc.authorize(tenantId, orderId, 1200, THRESHOLD, "auth:k");
    expect(a.outcome).toBe("authorized");
    const again = await svc.authorize(tenantId, orderId, 1200, THRESHOLD, "auth:k");
    expect(again.paymentId).toBe(a.paymentId); // same row, no duplicate
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    await cleanup(orderId);
  });

  it("declines at/above the threshold", async () => {
    const { tenantId, orderId } = ids();
    const a = await svc.authorize(tenantId, orderId, 100000, THRESHOLD, "auth:k");
    expect(a.outcome).toBe("declined");
    const row = await prisma.payment.findFirst({ where: { orderId } });
    expect(row?.status).toBe(PAYMENT_STATUS.DECLINED);
    await cleanup(orderId);
  });

  it("captures an authorized payment (idempotent)", async () => {
    const { tenantId, orderId } = ids();
    await svc.authorize(tenantId, orderId, 1200, THRESHOLD, "auth:k");
    const c = await svc.capture(tenantId, orderId, "cap:k");
    expect(c.outcome).toBe("captured");
    const again = await svc.capture(tenantId, orderId, "cap:k");
    expect(again.outcome).toBe("captured");
    expect((await prisma.payment.findFirst({ where: { orderId } }))?.status).toBe(PAYMENT_STATUS.CAPTURED);
    await cleanup(orderId);
  });

  it("voids an authorized payment (idempotent)", async () => {
    const { tenantId, orderId } = ids();
    await svc.authorize(tenantId, orderId, 1200, THRESHOLD, "auth:k");
    const v = await svc.void(tenantId, orderId, "void:k");
    expect(v.outcome).toBe("voided");
    expect((await prisma.payment.findFirst({ where: { orderId } }))?.status).toBe(PAYMENT_STATUS.VOIDED);
    await cleanup(orderId);
  });

  it("rejects an illegal transition (capture a declined payment)", async () => {
    const { tenantId, orderId } = ids();
    await svc.authorize(tenantId, orderId, 100000, THRESHOLD, "auth:k"); // declined
    await expect(svc.capture(tenantId, orderId, "cap:k")).rejects.toThrow();
    await cleanup(orderId);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm jest apps/payments/test/payments.service.e2e-spec.ts`
Expected: FAIL — module `../src/payments.service` not found.

- [ ] **Step 5: Implement `apps/payments/src/payments.service.ts`**

```ts
import { Injectable, NotFoundException, ConflictException } from "@nestjs/common";
import { PAYMENT_STATUS, type PaymentStatus } from "@flashbite/contracts";
import { PaymentsPrismaService } from "./payments-prisma.service";
import { decideAuthorize, nextOnCapture, nextOnVoid, IllegalTransitionError } from "./payment-rules";

export interface PaymentOutcome {
  paymentId: string;
  outcome: "authorized" | "declined" | "captured" | "voided";
}

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PaymentsPrismaService) {}

  /** Idempotent: one payment row per (tenantId, orderId). Re-authorize returns the prior decision. */
  async authorize(
    tenantId: string,
    orderId: string,
    amount: number,
    declineThreshold: number,
    idempotencyKey: string,
  ): Promise<PaymentOutcome> {
    // eslint-disable-next-line no-console
    console.log(`[authorize] ${idempotencyKey} tenant=${tenantId} order=${orderId} amount=${amount}`);
    const existing = await this.prisma.payment.findUnique({ where: { tenantId_orderId: { tenantId, orderId } } });
    if (existing) {
      return { paymentId: existing.id, outcome: existing.status === PAYMENT_STATUS.DECLINED ? "declined" : "authorized" };
    }
    const status = decideAuthorize(amount, declineThreshold);
    const row = await this.prisma.payment.create({
      data: {
        tenantId,
        orderId,
        amount,
        status,
        authorizedAt: status === PAYMENT_STATUS.AUTHORIZED ? new Date() : null,
      },
    });
    return { paymentId: row.id, outcome: status === PAYMENT_STATUS.DECLINED ? "declined" : "authorized" };
  }

  async capture(tenantId: string, orderId: string, idempotencyKey: string): Promise<PaymentOutcome> {
    // eslint-disable-next-line no-console
    console.log(`[capture] ${idempotencyKey} tenant=${tenantId} order=${orderId}`);
    return this.transition(tenantId, orderId, nextOnCapture, "capturedAt", "captured");
  }

  async void(tenantId: string, orderId: string, idempotencyKey: string): Promise<PaymentOutcome> {
    // eslint-disable-next-line no-console
    console.log(`[void] ${idempotencyKey} tenant=${tenantId} order=${orderId}`);
    return this.transition(tenantId, orderId, nextOnVoid, "voidedAt", "voided");
  }

  private async transition(
    tenantId: string,
    orderId: string,
    next: (s: PaymentStatus) => PaymentStatus,
    stampField: "capturedAt" | "voidedAt",
    outcome: "captured" | "voided",
  ): Promise<PaymentOutcome> {
    const row = await this.prisma.payment.findUnique({ where: { tenantId_orderId: { tenantId, orderId } } });
    if (!row) throw new NotFoundException(`No payment for ${tenantId}:${orderId}`);
    let target: PaymentStatus;
    try {
      target = next(row.status as PaymentStatus);
    } catch (e) {
      if (e instanceof IllegalTransitionError) throw new ConflictException(e.message);
      throw e;
    }
    if (row.status !== target) {
      await this.prisma.payment.update({
        where: { tenantId_orderId: { tenantId, orderId } },
        data: { status: target, [stampField]: new Date() },
      });
    }
    return { paymentId: row.id, outcome };
  }
}
```

- [ ] **Step 6: Run the e2e to verify it passes**

Run: `pnpm jest apps/payments/test/payments.service.e2e-spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck**

Run: `pnpm exec tsc -p apps/payments/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/payments/src/payments-prisma.service.ts apps/payments/src/payments.service.ts apps/payments/test/payments.service.e2e-spec.ts apps/payments/prisma/migrations
git commit -m "feat(payments): PaymentsService (authorize/capture/void, idempotent) + migration"
```

---

## Task 6: PaymentsController + DTOs + module + HTTP e2e

**Files:**
- Create: `apps/payments/src/dto.ts`
- Create: `apps/payments/src/payments.controller.ts`
- Create: `apps/payments/src/payments.module.ts`
- Modify: `apps/payments/src/app.module.ts`
- Create: `apps/payments/test/payments.e2e-spec.ts`

- [ ] **Step 1: `apps/payments/src/dto.ts`**

```ts
import { IsInt, IsString, Min } from "class-validator";

export class AuthorizeDto {
  @IsString() tenantId!: string;
  @IsString() orderId!: string;
  @IsInt() @Min(0) amount!: number;
  @IsString() idempotencyKey!: string;
}

export class CaptureVoidDto {
  @IsString() tenantId!: string;
  @IsString() orderId!: string;
  @IsString() idempotencyKey!: string;
}
```

- [ ] **Step 2: `apps/payments/src/payments.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { PaymentsPrismaService } from "./payments-prisma.service";
import { PaymentsService } from "./payments.service";
import { PaymentsController } from "./payments.controller";

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsPrismaService, PaymentsService],
})
export class PaymentsModule {}
```

- [ ] **Step 3: `apps/payments/src/payments.controller.ts`** (reads the threshold from env)

```ts
import { Body, Controller, Post } from "@nestjs/common";
import type { PaymentOutcome } from "./payments.service";
import { PaymentsService } from "./payments.service";
import { AuthorizeDto, CaptureVoidDto } from "./dto";

const DECLINE_THRESHOLD = Number(process.env.AUTH_DECLINE_THRESHOLD ?? 100000);

@Controller("payments")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post("authorize")
  authorize(@Body() body: AuthorizeDto): Promise<PaymentOutcome> {
    return this.payments.authorize(body.tenantId, body.orderId, body.amount, DECLINE_THRESHOLD, body.idempotencyKey);
  }

  @Post("capture")
  capture(@Body() body: CaptureVoidDto): Promise<PaymentOutcome> {
    return this.payments.capture(body.tenantId, body.orderId, body.idempotencyKey);
  }

  @Post("void")
  void(@Body() body: CaptureVoidDto): Promise<PaymentOutcome> {
    return this.payments.void(body.tenantId, body.orderId, body.idempotencyKey);
  }
}
```

- [ ] **Step 4: Wire `PaymentsModule` into `apps/payments/src/app.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { PaymentsModule } from "./payments.module";

@Module({
  imports: [PaymentsModule],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 5: Write the failing HTTP e2e `apps/payments/test/payments.e2e-spec.ts`**

```ts
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("payments HTTP (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it("authorize -> capture happy path", async () => {
    const orderId = randomUUID();
    const auth = await request(app.getHttpServer())
      .post("/payments/authorize")
      .send({ tenantId: "berlin", orderId, amount: 1200, idempotencyKey: `auth:berlin:${orderId}` })
      .expect(201);
    expect(auth.body.outcome).toBe("authorized");

    const cap = await request(app.getHttpServer())
      .post("/payments/capture")
      .send({ tenantId: "berlin", orderId, idempotencyKey: `capture:berlin:${orderId}` })
      .expect(201);
    expect(cap.body.outcome).toBe("captured");
  });

  it("declines at/above the threshold", async () => {
    const orderId = randomUUID();
    const auth = await request(app.getHttpServer())
      .post("/payments/authorize")
      .send({ tenantId: "berlin", orderId, amount: 100000, idempotencyKey: `auth:berlin:${orderId}` })
      .expect(201);
    expect(auth.body.outcome).toBe("declined");
  });

  it("400 on a malformed body (missing amount)", async () => {
    await request(app.getHttpServer())
      .post("/payments/authorize")
      .send({ tenantId: "berlin", orderId: "x", idempotencyKey: "k" })
      .expect(400);
  });
});
```

> NestJS `@Post` returns 201 by default — assert 201.

- [ ] **Step 6: Run it to verify it fails then passes**

Run: `pnpm jest apps/payments/test/payments.e2e-spec.ts`
Expected: first FAIL (controller/module absent), then after Steps 1–4 are in place, PASS (3 tests). (Requires infra + `flashbite_payments`.)

- [ ] **Step 7: Typecheck**

Run: `pnpm exec tsc -p apps/payments/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/payments/src/dto.ts apps/payments/src/payments.controller.ts apps/payments/src/payments.module.ts apps/payments/src/app.module.ts apps/payments/test/payments.e2e-spec.ts
git commit -m "feat(payments): authorize/capture/void HTTP endpoints + e2e"
```

---

## Task 7: Saga payments-client (HTTP)

**Files:**
- Create: `apps/saga-worker/src/payments-client.ts`
- Create: `apps/saga-worker/test/payments-client.spec.ts`

- [ ] **Step 1: Write the failing test `apps/saga-worker/test/payments-client.spec.ts`** (stub fetch)

```ts
import { authorizePayment, capturePayment, voidPayment } from "../src/payments-client";

describe("payments-client", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function stub(status: number, body: unknown) {
    globalThis.fetch = (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
  }

  it("authorize maps outcome to a boolean and sends an idempotency key", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 201, json: async () => ({ paymentId: "p1", outcome: "authorized" }) };
    }) as unknown as typeof fetch;

    const r = await authorizePayment("http://pay", "berlin", "o1", 1200);
    expect(r.authorized).toBe(true);
    expect(calls[0].url).toBe("http://pay/payments/authorize");
    expect(calls[0].body).toMatchObject({ tenantId: "berlin", orderId: "o1", amount: 1200, idempotencyKey: "authorize:berlin:o1" });
  });

  it("authorize returns authorized=false on a declined outcome", async () => {
    stub(201, { paymentId: "p1", outcome: "declined" });
    expect((await authorizePayment("http://pay", "berlin", "o1", 100000)).authorized).toBe(false);
  });

  it("capture/void resolve on 2xx", async () => {
    stub(201, { paymentId: "p1", outcome: "captured" });
    await expect(capturePayment("http://pay", "berlin", "o1")).resolves.toBeUndefined();
    stub(201, { paymentId: "p1", outcome: "voided" });
    await expect(voidPayment("http://pay", "berlin", "o1")).resolves.toBeUndefined();
  });

  it("throws on a non-2xx response (so Temporal retries)", async () => {
    stub(500, { error: "boom" });
    await expect(capturePayment("http://pay", "berlin", "o1")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest apps/saga-worker/test/payments-client.spec.ts`
Expected: FAIL — module `../src/payments-client` not found.

- [ ] **Step 3: Implement `apps/saga-worker/src/payments-client.ts`**

```ts
import type { PaymentResponse } from "@flashbite/contracts";

async function post(baseUrl: string, path: string, body: unknown): Promise<PaymentResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`payments ${path} failed: ${res.status}`);
  return (await res.json()) as PaymentResponse;
}

/** Authorize a hold. Stable idempotency key per order so Temporal retries never double-charge. */
export async function authorizePayment(
  baseUrl: string,
  tenantId: string,
  orderId: string,
  amount: number,
): Promise<{ authorized: boolean }> {
  const r = await post(baseUrl, "/payments/authorize", {
    tenantId,
    orderId,
    amount,
    idempotencyKey: `authorize:${tenantId}:${orderId}`,
  });
  return { authorized: r.outcome !== "declined" };
}

export async function capturePayment(baseUrl: string, tenantId: string, orderId: string): Promise<void> {
  await post(baseUrl, "/payments/capture", { tenantId, orderId, idempotencyKey: `capture:${tenantId}:${orderId}` });
}

export async function voidPayment(baseUrl: string, tenantId: string, orderId: string): Promise<void> {
  await post(baseUrl, "/payments/void", { tenantId, orderId, idempotencyKey: `void:${tenantId}:${orderId}` });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm jest apps/saga-worker/test/payments-client.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/saga-worker/src/payments-client.ts apps/saga-worker/test/payments-client.spec.ts
git commit -m "feat(saga-worker): payments HTTP client (authorize/capture/void, idempotency keys)"
```

---

## Task 8: Saga activities + workflow rewrite + workflow unit test

**Files:**
- Modify: `apps/saga-worker/src/activities.ts`
- Modify: `apps/saga-worker/src/workflows.ts`
- Modify: `apps/saga-worker/test/workflow.spec.ts`
- Modify: `apps/saga-worker/test/activities.spec.ts`

- [ ] **Step 1: Rewrite the payment activities in `apps/saga-worker/src/activities.ts`**

Change the imports to add config + the client:

```ts
import type { PrismaClient } from "@prisma/client";
import {
  loadAggregate, appendWithExpectedVersion,
  foldOrder, accept, cancel, INITIAL_ORDER_STATE, InvalidTransitionError,
  loadConfig,
} from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES } from "@flashbite/contracts";
import { authorizePayment, capturePayment, voidPayment } from "./payments-client";
```

Replace the two fake activities (`chargePaymentActivity`, `refundPaymentActivity`) with three real ones (keep `recordOrderAcceptedActivity` / `recordOrderCancelledActivity` exactly as they are):

```ts
    async authorizePaymentActivity(tenantId: string, orderId: string, amount: number): Promise<{ authorized: boolean }> {
      return authorizePayment(loadConfig().paymentsUrl, tenantId, orderId, amount);
    },
    async capturePaymentActivity(tenantId: string, orderId: string): Promise<void> {
      await capturePayment(loadConfig().paymentsUrl, tenantId, orderId);
    },
    async voidPaymentActivity(tenantId: string, orderId: string): Promise<void> {
      await voidPayment(loadConfig().paymentsUrl, tenantId, orderId);
    },
```

- [ ] **Step 2: Rewrite `apps/saga-worker/src/workflows.ts`**

```ts
import { proxyActivities, condition, defineSignal, setHandler } from "@temporalio/workflow";
import { ORDER_SAGA, ORDER_SAGA_RESULTS, ORDER_CANCEL_REASONS } from "@flashbite/contracts";
import type { Activities } from "./activities";

export const merchantApprovalSignal = defineSignal<[boolean]>(ORDER_SAGA.MERCHANT_APPROVAL_SIGNAL);

const { authorizePaymentActivity, capturePaymentActivity, voidPaymentActivity, recordOrderAcceptedActivity, recordOrderCancelledActivity } =
  proxyActivities<Activities>({ startToCloseTimeout: "1 minute" });

export interface OrderLifecycleArgs {
  tenantId: string;
  orderId: string;
  totalAmount: number;
  slaSeconds: number;
}

/**
 * Authorize a hold -> race the SLA timer against the merchant-approval signal.
 * Declined authorize -> OrderCancelled(PAYMENT_FAILED). Approved in time -> capture + OrderAccepted.
 * Declined or SLA breach -> void + OrderCancelled. Deterministic: all I/O is in activities.
 */
export async function orderLifecycleWorkflow(args: OrderLifecycleArgs): Promise<string> {
  let approved: boolean | undefined;
  setHandler(merchantApprovalSignal, (value) => { approved = value; });

  const { authorized } = await authorizePaymentActivity(args.tenantId, args.orderId, args.totalAmount);
  if (!authorized) {
    await recordOrderCancelledActivity(args.tenantId, args.orderId, ORDER_CANCEL_REASONS.PAYMENT_FAILED);
    return ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_FAILED;
  }

  const signalledInTime = await condition(() => approved !== undefined, `${args.slaSeconds}s`);

  if (signalledInTime && approved) {
    await capturePaymentActivity(args.tenantId, args.orderId);
    await recordOrderAcceptedActivity(args.tenantId, args.orderId);
    return ORDER_SAGA_RESULTS.ACCEPTED;
  }

  await voidPaymentActivity(args.tenantId, args.orderId);
  const reason = signalledInTime ? ORDER_CANCEL_REASONS.DECLINED : ORDER_CANCEL_REASONS.SLA_BREACH;
  await recordOrderCancelledActivity(args.tenantId, args.orderId, reason);
  return reason === ORDER_CANCEL_REASONS.SLA_BREACH ? ORDER_SAGA_RESULTS.CANCELLED_SLA : ORDER_SAGA_RESULTS.CANCELLED_DECLINED;
}
```

- [ ] **Step 3: Rewrite `apps/saga-worker/test/workflow.spec.ts`** (stub the new activities)

Replace the `stubActivities` object and the three `it` blocks' expectations, and add a payment-failed test. The full new stub + tests:

```ts
  let authorizeResult = true; // toggled per test
  const stubActivities = {
    async authorizePaymentActivity() { calls.push("authorize"); return { authorized: authorizeResult }; },
    async capturePaymentActivity() { calls.push("capture"); },
    async voidPaymentActivity() { calls.push("void"); },
    async recordOrderAcceptedActivity() { calls.push("accepted"); },
    async recordOrderCancelledActivity(_t: string, _o: string, reason: string) { calls.push(`cancelled:${reason}`); },
  };
```

- ACCEPTED test: set `authorizeResult = true;` at the top of the test body; expect `result` `"ACCEPTED"` and `calls` `["authorize", "capture", "accepted"]`.
- CANCELLED_SLA test: `authorizeResult = true;`; expect `"CANCELLED_SLA"` and `["authorize", "void", "cancelled:SLA_BREACH"]`.
- CANCELLED_DECLINED test: `authorizeResult = true;`; expect `"CANCELLED_DECLINED"` and `["authorize", "void", "cancelled:DECLINED"]`.
- NEW payment-failed test:

```ts
  it("CANCELLED_PAYMENT_FAILED when authorize is declined (no capture/void)", async () => {
    calls.length = 0; authorizeResult = false;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:payfail-${Date.now()}`,
        args: [{ tenantId: "berlin", orderId: "o4", totalAmount: 100000, slaSeconds: 300 }],
      });
      return handle.result();
    });
    expect(result).toBe("CANCELLED_PAYMENT_FAILED");
    expect(calls).toEqual(["authorize", "cancelled:PAYMENT_FAILED"]);
    authorizeResult = true; // reset
  });
```

(Set `authorizeResult = true;` at the start of the three pre-existing tests so order-independence holds.)

- [ ] **Step 4: Update `apps/saga-worker/test/activities.spec.ts`**

Remove the obsolete fake-gateway test (the one titled `"charge + refund activities resolve without throwing (fake gateway)"` — lines that call `chargePaymentActivity`/`refundPaymentActivity`). Keep the `recordOrderAccepted` test unchanged. (The new authorize/capture/void activities are HTTP wrappers, covered by the payments-client unit test in Task 7 and the saga e2e in Task 9.)

- [ ] **Step 5: Run the workflow + activities unit tests**

Run: `pnpm jest apps/saga-worker/test/workflow.spec.ts apps/saga-worker/test/activities.spec.ts`
Expected: PASS — 4 workflow tests (incl. payment-failed), activities test green. (`workflow.spec` uses the time-skipping test env; `activities.spec` needs Postgres up.)

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc -p apps/saga-worker/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/saga-worker/src/activities.ts apps/saga-worker/src/workflows.ts apps/saga-worker/test/workflow.spec.ts apps/saga-worker/test/activities.spec.ts
git commit -m "feat(saga-worker): authorize/capture/void lifecycle + PAYMENT_FAILED path"
```

---

## Task 9: Saga end-to-end (live Temporal + Postgres + payments)

**Files:**
- Modify: `apps/saga-worker/test/saga.e2e-spec.ts`
- Create: `apps/saga-worker/test/payment-failed.e2e-spec.ts`

Requires: `pnpm infra:up` + `flashbite_payments` migrated + **`pnpm dev:payments` running** (the saga workflow's activities call it over HTTP).

- [ ] **Step 1: Confirm the existing accept-path e2e still holds, and extend it to assert the payment was captured**

`apps/saga-worker/test/saga.e2e-spec.ts` already places an order with `totalAmount: 1200` (below the 100000 threshold → authorizes), signals approval, and asserts `ACCEPTED` + `[OrderPlaced, OrderAccepted]`. No change needed for the order assertions. Optionally add a payment-captured assertion by querying the payments DB — but that couples the saga test to the payments client. **Keep it order-focused**: leave `saga.e2e-spec.ts` as-is (it now exercises the real authorize+capture path because payments is running). Verify it passes:

Run: `pnpm jest apps/saga-worker/test/saga.e2e-spec.ts`
Expected: PASS (the workflow now authorizes via the real payments service, captures on approval, records `OrderAccepted`).

> If it fails with a fetch/connection error, the payments service isn't running — start `pnpm dev:payments`.

- [ ] **Step 2: Write the new payment-failed e2e `apps/saga-worker/test/payment-failed.e2e-spec.ts`**

```ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, appendWithExpectedVersion, TemporalHandle } from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES, ORDER_CANCEL_REASONS } from "@flashbite/contracts";
import { startSagaWorker, SagaWorkerHandle } from "../src/main";

describe("saga-worker payment-failed (e2e: declined authorize)", () => {
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

  it("a declining amount cancels the order with PAYMENT_FAILED and never accepts", async () => {
    const orderId = randomUUID();
    const declineAmount = 100000; // >= AUTH_DECLINE_THRESHOLD
    await appendWithExpectedVersion(prisma, {
      tenantId: "berlin",
      aggregateType: AGGREGATE_TYPES.ORDER,
      aggregateId: orderId,
      expectedVersion: 0,
      eventType: EVENT_TYPES.ORDER_PLACED,
      payload: { orderId, customerId: "c-1", items: [], totalAmount: declineAmount },
    });

    const handle = await temporal.client.workflow.start("orderLifecycleWorkflow", {
      taskQueue: "order-lifecycle",
      workflowId: `berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, totalAmount: declineAmount, slaSeconds: 60 }],
    });
    const result = await handle.result();
    expect(result).toBe("CANCELLED_PAYMENT_FAILED");

    const events = await prisma.eventStore.findMany({ where: { tenantId: "berlin", aggregateId: orderId }, orderBy: { version: "asc" } });
    expect(events.map((e) => e.eventType)).toEqual(["OrderPlaced", "OrderCancelled"]);
    const cancelled = events[1].payload as { reason: string };
    expect(cancelled.reason).toBe(ORDER_CANCEL_REASONS.PAYMENT_FAILED);

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${orderId}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: orderId } });
  }, 60000);
});
```

- [ ] **Step 3: Run the saga e2e suite (infra + payments running)**

Run: `pnpm jest apps/saga-worker/test/saga.e2e-spec.ts apps/saga-worker/test/breach.e2e-spec.ts apps/saga-worker/test/payment-failed.e2e-spec.ts`
Expected: PASS — accept→capture, SLA breach→void→cancel, declined authorize→PAYMENT_FAILED. (`breach.e2e-spec.ts` uses `totalAmount` below the threshold so it authorizes then voids on breach — confirm its amount is `< 100000`; the existing value is fine.)

- [ ] **Step 4: Commit**

```bash
git add apps/saga-worker/test/saga.e2e-spec.ts apps/saga-worker/test/payment-failed.e2e-spec.ts
git commit -m "test(saga-worker): payment-failed e2e + verify capture/void paths over real payments"
```

---

## Task 10: Frontend — `PAYMENT_FAILED` label

**Files:**
- Modify: the web-shared status/label helper that maps `cancelReason` to display text (find it: `grep -rln "SLA_BREACH\|cancelReason\|DECLINED" packages/web-shared/src`)
- Modify/Create: its colocated test

- [ ] **Step 1: Locate the cancel-reason label mapping**

Run: `grep -rn "SLA_BREACH\|DECLINED" packages/web-shared/src`
Identify the helper that turns a `cancelReason` into a human label (e.g. a `cancelReasonLabel` map in a status helpers file). If no such mapping exists (the UI shows the raw reason), add a small `cancelReasonLabel(reason)` helper in the existing status-helpers file and export it.

- [ ] **Step 2: Add the failing test**

In the colocated test for that helper (e.g. `packages/web-shared/src/orders/status.test.ts` — match the actual filename), add:

```ts
import { cancelReasonLabel } from "./<status-helpers-file>"; // match the real path

describe("cancelReasonLabel", () => {
  it("maps PAYMENT_FAILED to a readable label", () => {
    expect(cancelReasonLabel("PAYMENT_FAILED")).toBe("Payment failed");
  });
  it("maps the existing reasons", () => {
    expect(cancelReasonLabel("SLA_BREACH")).toBe("SLA breach");
    expect(cancelReasonLabel("DECLINED")).toBe("Declined by merchant");
  });
});
```

(Adjust the existing-reason expectations to whatever labels the helper already uses; the new assertion is the `PAYMENT_FAILED` one.)

- [ ] **Step 3: Run it (Vitest) to verify it fails**

Run: `pnpm --filter @flashbite/web-shared test`
Expected: FAIL on the `PAYMENT_FAILED` case (or "cancelReasonLabel is not a function" if newly added).

- [ ] **Step 4: Add/extend the helper**

Add `PAYMENT_FAILED: "Payment failed"` to the existing label map (or create the helper):

```ts
const CANCEL_REASON_LABELS: Record<string, string> = {
  SLA_BREACH: "SLA breach",
  DECLINED: "Declined by merchant",
  PAYMENT_FAILED: "Payment failed",
};
export function cancelReasonLabel(reason: string | undefined): string {
  return reason ? (CANCEL_REASON_LABELS[reason] ?? reason) : "";
}
```

(If a label map already exists, just add the `PAYMENT_FAILED` entry and keep the existing function.)

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @flashbite/web-shared test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web-shared/src
git commit -m "feat(web-shared): PAYMENT_FAILED cancel-reason label"
```

---

## Task 11: CI + docs + full verification

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `README.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: Wire payments into CI (`.github/workflows/test.yml`)**

Add to the job-level `env:` block:

```yaml
      PAYMENTS_URL: http://localhost:3004
      PAYMENTS_DATABASE_URL: postgresql://flashbite:local_dev_only_change_me@localhost:5434/flashbite_payments
      AUTH_DECLINE_THRESHOLD: "100000"
```

After the existing "Generate Prisma client + apply migrations" step, add a payments DB step:

```yaml
      - name: Payments DB (generate + migrate)
        run: |
          pnpm payments:generate
          pnpm payments:db:deploy
```

(The `flashbite_payments` database itself is created by the `postgres-init` SQL on the fresh CI volume — Task 2.)

Replace the "Run tests" step so the payments service runs for the saga e2e:

```yaml
      - name: Run tests
        run: |
          pnpm dev:payments & echo $! > /tmp/payments.pid
          node -e "const u='http://localhost:3004/health';const t=Date.now()+30000;(async function p(){try{const r=await fetch(u);if(r.ok)return console.log('payments ready');}catch{}if(Date.now()>t){console.error('payments not ready');process.exit(1);}setTimeout(p,1000);})();"
          pnpm test
          kill $(cat /tmp/payments.pid) 2>/dev/null || true
```

> `pnpm dev:payments` uses `--env-file=.env`, which doesn't exist in CI; change the `dev:payments`
> invocation here to not require it — run payments via its env from the job env instead:
> `node -r @swc-node/register -r tsconfig-paths/register apps/payments/src/main.ts & ...`
> (the job `env:` already provides `PAYMENTS_DATABASE_URL`/`AUTH_DECLINE_THRESHOLD`). Use that exact
> command in the CI step instead of `pnpm dev:payments`.

- [ ] **Step 2: Validate the workflow YAML**

Run: `node -e "const yaml=require('js-yaml'),fs=require('fs');yaml.load(fs.readFileSync('.github/workflows/test.yml','utf8'));console.log('YAML OK')"` (if `js-yaml` isn't resolvable, `cd /tmp && npm i js-yaml >/dev/null 2>&1` first, then run the same with an absolute path). If neither works, visually confirm the new steps' indentation matches the sibling steps exactly.
Expected: `YAML OK` (or a clean visual match).

- [ ] **Step 3: Update `README.md`**

- Dev quick-start: add `pnpm payments:db:create` (one-time, existing volumes) and `pnpm dev:payments` (`:3004`) to the run list, and `pnpm payments:generate` to setup.
- Note the order lifecycle now does **authorize → capture/void** via the `payments` service, with a deterministic decline (`AUTH_DECLINE_THRESHOLD`) producing `PAYMENT_FAILED`.
- Add `payments :3004` to the services/surfaces table; add the new env vars.

- [ ] **Step 4: Update `docs/ARCHITECTURE.md`**

- §2 components table: add the `payments` service row (own `flashbite_payments` DB, authorize/capture/void, internal). Add `flashbite_payments` to the infra description.
- §3 order lifecycle: update the saga prose (and, if present, the SLA-race sequence diagram messages) from "charge / refund" to "authorize → capture / void", and add the declined-authorize → `OrderCancelled(PAYMENT_FAILED)` branch. **Mermaid safety:** if you edit a diagram, no bare `+` / second `:` in sequence message text, no `->` inside flowchart labels; then validate ALL blocks offline (mermaid.parse v11) and report `N/N parsed OK`.
- §9: remove "Real payment provider — charge/refund are fake Temporal activities" from "Not yet built"; add a "**Completed in Phase 3c**" note (self-built payments, authorize/capture/void, idempotent, deterministic decline; refund / webhook settlement / payment read model remain backlog).

- [ ] **Step 5: Full verification**

```bash
pnpm infra:up
pnpm payments:db:create        # if the volume predates this phase
pnpm payments:generate && pnpm payments:db:deploy
pnpm register:schemas
pnpm dev:payments &            # for the saga e2e
pnpm jest
```
Expected: all suites green — payments rules/service/HTTP e2e, saga workflow + payment-failed/accept/breach e2e, plus the existing order/telemetry/Avro/auth/RLS suites. (The pre-existing `merchant-orders.e2e` data-pollution flake may still fail; classify it, don't fix it here.)

- [ ] **Step 6: Repo-wide typecheck**

```bash
for d in packages/* apps/*; do [ -f "$d/tsconfig.json" ] && pnpm exec tsc -p "$d/tsconfig.json" --noEmit; done
```
Expected: PASS (payments included).

- [ ] **Step 7: Confirm the fakes are gone**

Run: `grep -rn "chargePaymentActivity\|refundPaymentActivity\|fake payment\|Fake payment" apps/saga-worker/src`
Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/test.yml README.md docs/ARCHITECTURE.md
git commit -m "ci+docs(payments): provision flashbite_payments + run payments for saga e2e; document Phase 3c"
```

---

## Self-review notes (coverage map)

- Spec "self-built payments service (:3004, own DB, own Prisma)" → Tasks 2, 3, 5.
- Spec "authorize/capture/void endpoints, idempotent" → Tasks 5, 6.
- Spec "deterministic amount-based decline" → Task 4 (`decideAuthorize`) + `AUTH_DECLINE_THRESHOLD`.
- Spec "saga drives synchronous authorize→capture/void; PAYMENT_FAILED" → Tasks 7, 8.
- Spec "contracts: PAYMENT_FAILED + CANCELLED_PAYMENT_FAILED; shared paymentsUrl" → Task 1.
- Spec "payments owns ledger; Order aggregate unchanged" → Tasks 3/5 (no change to aggregate; verified by Task 11 grep + full suite).
- Spec "ledger keyed by (tenantId, orderId); idempotency" → Task 5 + Task 6/7 tests.
- Spec "frontend PAYMENT_FAILED label" → Task 10.
- Spec "tests: payments e2e + saga e2e (failed/accept/decline-SLA)" → Tasks 5, 6, 8, 9.
- Spec "config/infra: new DB, dev:payments, CI provisioning" → Tasks 2, 11.
- Spec "no refund / no Kafka for payments" → not built (verified: payments has no Kafka deps; only authorize/capture/void).
