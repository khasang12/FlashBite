# Phase 4a — Observability Story Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Structured JSON logging (pino) across every service and worker, with a `correlationId` propagated end-to-end so one id traces a single order through HTTP → outbox → Kafka → projection/saga/telemetry.

**Architecture:** A shared pino logger factory + an `obsContext` AsyncLocalStorage in `@flashbite/shared`; the logger's `mixin` auto-attaches the ALS context to every line. `correlationId` is added to `EventEnvelope` (already persisted as JSON in `outbox.payload`, so no DB migration) and to the Kafka header serde. HTTP requests mint/ingest the id (middleware in `@flashbite/tenant-context`); Kafka consumers rebind it per message; the saga reads it from the consumed envelope and threads it through the workflow into the events it appends.

**Tech Stack:** pino + pino-pretty; NestJS 10; kafkajs; Temporal; Prisma; jest/ts-jest (backend) + vitest (web-shared, not used here).

## Global Constraints

- Structured logs to **stdout only** — no Prometheus/Grafana/OTel/Loki, no `/metrics`, no new infra containers.
- Logger config must be **import-safe** (no throw at module load).
- Kafka header parse stays **fail-closed on `eventType`/`tenantId`/`eventId`**; `correlationId` is **lenient** (missing → freshly minted id, never throws).
- **No DB migration** — `correlationId` rides inside the JSON `EventEnvelope` stored in `outbox.payload`.
- `@flashbite/contracts` must stay free of `node:crypto`/runtime I/O (Temporal-bundle-safe) — only the `correlationId: string` **type** field is added there; minting/reading lives in `@flashbite/shared`.
- Reuse the existing Temporal Web UI (:8080) and Redpanda Console (:8085); do not add observability UIs.
- One concise request-completion log line per HTTP request, **all endpoints** (not only mutations).
- CLI one-shot scripts (`apps/identity/src/seed*.ts`, `apps/projection-worker/src/rebuild.ts`, `packages/messaging/src/register.ts`) are **out of scope** — leave their `console.*` as-is. Only long-running service/worker runtime paths convert.
- Backend tests run via root `pnpm test` (jest). Live e2e needs infra up (`pnpm bootstrap`).

---

### Task 1: Shared logger + obsContext

**Files:**
- Create: `packages/shared/src/logger.ts`
- Create: `packages/shared/src/obs-context.ts`
- Create (test): `packages/shared/src/obs-context.spec.ts`
- Modify: `packages/shared/src/index.ts` (exports)
- Modify: `packages/shared/package.json` (add `pino`, `pino-pretty`)

**Interfaces:**
- Produces: `interface ObsContext { correlationId: string; tenantId?: string; eventId?: string }`; `runWithObsContext<T>(ctx: ObsContext, fn: () => T): T`; `getObsContext(): ObsContext | undefined`; `newCorrelationId(): string`; `obsLogFields(): Record<string, string>`; `createLogger(service: string): import("pino").Logger`.

- [ ] **Step 1: Add deps**

```bash
cd /Users/sangkha/Documents/Study/Learning/FlashBite
pnpm --filter @flashbite/shared add pino@^9 pino-pretty@^13
```

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/obs-context.spec.ts`:

```ts
import { runWithObsContext, getObsContext, newCorrelationId, obsLogFields } from "./obs-context";

describe("obs-context", () => {
  it("exposes the bound context inside the scope and nothing outside", () => {
    expect(getObsContext()).toBeUndefined();
    const out = runWithObsContext({ correlationId: "c1", tenantId: "berlin" }, () => {
      const ctx = getObsContext();
      return ctx?.correlationId + ":" + ctx?.tenantId;
    });
    expect(out).toBe("c1:berlin");
    expect(getObsContext()).toBeUndefined();
  });

  it("obsLogFields returns correlationId + present fields, omitting undefined", () => {
    expect(obsLogFields()).toEqual({});
    const fields = runWithObsContext({ correlationId: "c2", eventId: "e2" }, () => obsLogFields());
    expect(fields).toEqual({ correlationId: "c2", eventId: "e2" });
  });

  it("newCorrelationId returns a uuid-shaped string", () => {
    expect(newCorrelationId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL**

Run: `npx jest packages/shared/src/obs-context.spec.ts`
Expected: FAIL (module not found / functions undefined).

- [ ] **Step 4: Implement obs-context**

Create `packages/shared/src/obs-context.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Per-request / per-message logging context, merged into every log line by the pino mixin. */
export interface ObsContext {
  correlationId: string;
  tenantId?: string;
  eventId?: string;
}

const storage = new AsyncLocalStorage<ObsContext>();

export function runWithObsContext<T>(ctx: ObsContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getObsContext(): ObsContext | undefined {
  return storage.getStore();
}

export function newCorrelationId(): string {
  return randomUUID();
}

/** Flattens the current ObsContext into log fields, omitting absent ones. Used as the pino mixin. */
export function obsLogFields(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  const out: Record<string, string> = { correlationId: ctx.correlationId };
  if (ctx.tenantId) out.tenantId = ctx.tenantId;
  if (ctx.eventId) out.eventId = ctx.eventId;
  return out;
}
```

- [ ] **Step 5: Implement logger**

Create `packages/shared/src/logger.ts`:

```ts
import pino, { type Logger } from "pino";
import { obsLogFields } from "./obs-context";

/**
 * Structured JSON logger. JSON to stdout in production; pretty in dev. The mixin attaches the
 * current obsContext (correlationId/tenantId/eventId) to every line, so call sites pass none.
 */
export function createLogger(service: string): Logger {
  const pretty = process.env.NODE_ENV !== "production";
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service },
    mixin: () => obsLogFields(),
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:standard", ignore: "pid,hostname" } } }
      : {}),
  });
}
```

- [ ] **Step 6: Export from index**

In `packages/shared/src/index.ts` add:

```ts
export { createLogger } from "./logger";
export { runWithObsContext, getObsContext, newCorrelationId, obsLogFields, type ObsContext } from "./obs-context";
```

- [ ] **Step 7: Run test — expect PASS**

Run: `npx jest packages/shared/src/obs-context.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/logger.ts packages/shared/src/obs-context.ts packages/shared/src/obs-context.spec.ts packages/shared/src/index.ts packages/shared/package.json pnpm-lock.yaml
git commit -m "feat(shared): pino logger + obsContext ALS for structured correlated logs"
```

---

### Task 2: correlationId on the envelope + Kafka header serde

**Files:**
- Modify: `packages/contracts/src/index.ts` (EventEnvelope)
- Modify: `packages/shared/src/envelope.ts` (buildEnvelope precedence)
- Modify: `packages/shared/src/aggregate-store.ts` (AppendArgs optional correlationId)
- Modify: `packages/messaging/src/headers.ts` (buildHeaders/parseHeaders)
- Modify (test): `packages/messaging/src/headers.spec.ts`
- Create (test): `packages/shared/src/envelope.spec.ts`

**Interfaces:**
- Consumes: `getObsContext`, `newCorrelationId` (Task 1).
- Produces: `EventEnvelope.correlationId: string`; `EnvelopeMeta.correlationId`; `buildEnvelope(args)` stamps correlationId; `AppendArgs.correlationId?: string`.

- [ ] **Step 1: Write failing header test**

In `packages/messaging/src/headers.spec.ts` add:

```ts
import { buildHeaders, parseHeaders } from "./headers";

describe("correlationId header", () => {
  const base = { eventType: "OrderPlaced", tenantId: "berlin", eventId: "e1", version: 1, occurredAt: "2026-01-01T00:00:00.000Z" };

  it("round-trips correlationId through build/parse", () => {
    const headers = buildHeaders({ ...base, correlationId: "corr-123" });
    expect(headers.correlationId).toBe("corr-123");
    expect(parseHeaders(headers as any).correlationId).toBe("corr-123");
  });

  it("mints a correlationId when the header is absent (lenient), without throwing", () => {
    const headers = buildHeaders(base as any); // correlationId omitted upstream
    const meta = parseHeaders({ eventType: Buffer.from("OrderPlaced"), tenantId: Buffer.from("berlin"), eventId: Buffer.from("e1") } as any);
    expect(meta.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    void headers;
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest packages/messaging/src/headers.spec.ts`
Expected: FAIL (`correlationId` not on type / undefined).

- [ ] **Step 3: Add field to EventEnvelope**

In `packages/contracts/src/index.ts`, add `correlationId` to the interface:

```ts
export interface EventEnvelope<T = unknown> {
  tenantId: string;
  eventId: string;
  eventType: string;
  version: number;
  occurredAt: string;
  correlationId: string;
  payload: T;
}
```

- [ ] **Step 4: Update header serde**

In `packages/messaging/src/headers.ts`:
- In `buildHeaders`, add `correlationId: meta.correlationId` to the returned object.
- In `parseHeaders`, after building the result, set `correlationId`:

```ts
import { newCorrelationId } from "@flashbite/shared";
// ... inside parseHeaders return object, add:
    correlationId: s("correlationId") || newCorrelationId(),
```

(Keep `REQUIRED_HEADERS` unchanged — correlationId stays lenient.)

- [ ] **Step 5: Stamp correlationId in buildEnvelope**

In `packages/shared/src/envelope.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@flashbite/contracts";
import { getObsContext } from "./obs-context";

export function buildEnvelope<T>(args: {
  tenantId: string;
  eventType: string;
  version: number;
  payload: T;
  eventId?: string;
  occurredAt?: string;
  correlationId?: string;
}): EventEnvelope<T> {
  return {
    tenantId: args.tenantId,
    eventId: args.eventId ?? randomUUID(),
    eventType: args.eventType,
    version: args.version,
    occurredAt: args.occurredAt ?? new Date().toISOString(),
    correlationId: args.correlationId ?? getObsContext()?.correlationId ?? randomUUID(),
    payload: args.payload,
  };
}
```

- [ ] **Step 6: Thread correlationId through AppendArgs**

In `packages/shared/src/aggregate-store.ts`, add `correlationId?: string;` to `AppendArgs`, and pass it into `buildEnvelope`:

```ts
  const envelope = buildEnvelope({ tenantId: args.tenantId, eventType: args.eventType, version, payload: args.payload, correlationId: args.correlationId });
```

- [ ] **Step 7: Write envelope precedence test**

Create `packages/shared/src/envelope.spec.ts`:

```ts
import { buildEnvelope } from "./envelope";
import { runWithObsContext } from "./obs-context";

describe("buildEnvelope correlationId precedence", () => {
  const a = { tenantId: "berlin", eventType: "OrderPlaced", version: 1, payload: {} };

  it("prefers an explicit correlationId arg", () => {
    expect(buildEnvelope({ ...a, correlationId: "explicit" }).correlationId).toBe("explicit");
  });
  it("falls back to obsContext", () => {
    const env = runWithObsContext({ correlationId: "from-als" }, () => buildEnvelope(a));
    expect(env.correlationId).toBe("from-als");
  });
  it("mints one when nothing is in scope", () => {
    expect(buildEnvelope(a).correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

- [ ] **Step 8: Run tests — expect PASS**

Run: `npx jest packages/messaging/src/headers.spec.ts packages/shared/src/envelope.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/index.ts packages/shared/src/envelope.ts packages/shared/src/aggregate-store.ts packages/shared/src/envelope.spec.ts packages/messaging/src/headers.ts packages/messaging/src/headers.spec.ts
git commit -m "feat(contracts,messaging): correlationId on envelope + lenient header serde"
```

---

### Task 3: HTTP correlation middleware + wire all 4 NestJS apps

**Files:**
- Create: `packages/tenant-context/src/correlation.middleware.ts`
- Create (test): `packages/tenant-context/src/correlation.middleware.spec.ts`
- Modify: `packages/tenant-context/src/auth.middleware.ts` (set obs tenantId post-verify)
- Modify: `packages/tenant-context/src/index.ts` (export)
- Modify: `apps/{write-api,read-api,identity,payments}/src/app.module.ts` (register middleware + provide logger)

**Interfaces:**
- Consumes: `runWithObsContext`, `getObsContext`, `newCorrelationId`, `createLogger` (Tasks 1).
- Produces: `CorrelationMiddleware` (NestMiddleware); constructor takes a pino `Logger`.

- [ ] **Step 1: Write failing test**

Create `packages/tenant-context/src/correlation.middleware.spec.ts`:

```ts
import { CorrelationMiddleware } from "./correlation.middleware";
import { getObsContext } from "@flashbite/shared";
import pino from "pino";

function res() {
  const handlers: Record<string, () => void> = {};
  return {
    setHeader: jest.fn(),
    statusCode: 200,
    on: (ev: string, cb: () => void) => { handlers[ev] = cb; },
    finish: () => handlers["finish"]?.(),
  } as any;
}

describe("CorrelationMiddleware", () => {
  const mw = new CorrelationMiddleware(pino({ enabled: false }));

  it("mints a correlationId and binds obsContext for the request scope", () => {
    const r = res();
    let seen: string | undefined;
    mw.use({ headers: {}, method: "GET", originalUrl: "/x" } as any, r, () => { seen = getObsContext()?.correlationId; });
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.setHeader).toHaveBeenCalledWith("x-correlation-id", seen);
  });

  it("ingests an inbound x-correlation-id", () => {
    const r = res();
    let seen: string | undefined;
    mw.use({ headers: { "x-correlation-id": "inbound-1" }, method: "GET", originalUrl: "/x" } as any, r, () => { seen = getObsContext()?.correlationId; });
    expect(seen).toBe("inbound-1");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest packages/tenant-context/src/correlation.middleware.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the middleware**

Create `packages/tenant-context/src/correlation.middleware.ts`:

```ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import type { Logger } from "pino";
import { runWithObsContext, newCorrelationId, type ObsContext } from "@flashbite/shared";

/**
 * Mints or ingests a correlationId, binds the obsContext for the request, echoes the id on the
 * response, and logs one completion line. Register BEFORE AuthMiddleware so even 401s/health are
 * correlated; AuthMiddleware later fills obs.tenantId once the JWT is verified.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(private readonly log: Logger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers["x-correlation-id"];
    const correlationId = (Array.isArray(inbound) ? inbound[0] : inbound) || newCorrelationId();
    const obs: ObsContext = { correlationId };
    res.setHeader("x-correlation-id", correlationId);
    const start = Date.now();
    res.on("finish", () => {
      this.log.info({ method: req.method, path: req.originalUrl, statusCode: res.statusCode, durationMs: Date.now() - start }, "request");
    });
    runWithObsContext(obs, () => next());
  }
}
```

- [ ] **Step 4: AuthMiddleware fills obs.tenantId**

In `packages/tenant-context/src/auth.middleware.ts`, after a successful `verify`, set the tenant on the live obsContext object before running auth:

```ts
import { getObsContext } from "@flashbite/shared";
// ... after `ctx = await this.verifier.verify(token);`
    const obs = getObsContext();
    if (obs) obs.tenantId = ctx.tenantId;
    runWithAuth(ctx, () => next());
```

- [ ] **Step 5: Export**

In `packages/tenant-context/src/index.ts` add `export * from "./correlation.middleware";`.

- [ ] **Step 6: Run middleware test — expect PASS**

Run: `npx jest packages/tenant-context/src/correlation.middleware.spec.ts`
Expected: PASS.

- [ ] **Step 7: Wire each NestJS app**

In EACH of `apps/write-api/src/app.module.ts`, `apps/read-api/src/app.module.ts`, `apps/identity/src/app.module.ts`, `apps/payments/src/app.module.ts`:

(a) import and provide a request logger + the middleware. Add to imports:

```ts
import { CorrelationMiddleware, AuthMiddleware } from "@flashbite/tenant-context";
import { createLogger } from "@flashbite/shared";
```

(b) add a provider so the middleware gets a service-named logger (use the app's name — `write-api`/`read-api`/`identity`/`payments`):

```ts
  providers: [
    // ...existing providers...
    { provide: CorrelationMiddleware, usefactory: () => new CorrelationMiddleware(createLogger("write-api")) },
  ],
```

(c) register in `configure`, correlation first (no exclude — correlate health too), auth second (excludes health). For identity (which has no AuthMiddleware) register only correlation:

```ts
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
    consumer.apply(AuthMiddleware).exclude("health").forRoutes("*"); // omit this line in identity
  }
```

> identity's current `app.module.ts` may not implement `NestModule`/`configure`; add `implements NestModule` and the `configure` with only the CorrelationMiddleware line. Read each module before editing and preserve its existing providers/guards.

- [ ] **Step 8: Verify build + targeted tests**

Run: `npx tsc --noEmit -p apps/write-api/tsconfig.json && npx tsc --noEmit -p apps/read-api/tsconfig.json && npx tsc --noEmit -p apps/identity/tsconfig.json && npx tsc --noEmit -p apps/payments/tsconfig.json`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/tenant-context/src/correlation.middleware.ts packages/tenant-context/src/correlation.middleware.spec.ts packages/tenant-context/src/auth.middleware.ts packages/tenant-context/src/index.ts apps/write-api/src/app.module.ts apps/read-api/src/app.module.ts apps/identity/src/app.module.ts apps/payments/src/app.module.ts
git commit -m "feat(tenant-context): correlation-id middleware + request log; wire all NestJS apps"
```

---

### Task 4: outbox-poller — per-row context + structured logs

**Files:**
- Modify: `apps/outbox-poller/src/poller.ts` (bind obsContext per row)
- Modify: `apps/outbox-poller/src/main.ts` (replace console with createLogger)

**Interfaces:**
- Consumes: `runWithObsContext`, `createLogger` (Task 1); envelope now carries `correlationId` (Task 2), so `buildHeaders` emits it automatically.

- [ ] **Step 1: Bind context around each publish**

In `apps/outbox-poller/src/poller.ts`, wrap the publish of each row so its logs are correlated. Read the row's envelope from `row.payload`:

```ts
import { runWithObsContext, createLogger } from "@flashbite/shared";
const log = createLogger("outbox-poller");
// ... where it publishes a row (around line 20):
    const env = row.payload as unknown as EventEnvelope;
    await runWithObsContext({ correlationId: env.correlationId, tenantId: env.tenantId, eventId: env.eventId }, async () => {
      await publishEnvelope(producer, registry, row.topic, row.partitionKey, env);
      log.info({ topic: row.topic, eventType: env.eventType }, "published");
    });
```

- [ ] **Step 2: Replace console in main.ts**

In `apps/outbox-poller/src/main.ts`, replace the startup/error `console.*` with `createLogger("outbox-poller")` (`log.info("outbox-poller running")`, `log.error({ err }, "fatal")`).

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit -p apps/outbox-poller/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/outbox-poller/src/poller.ts apps/outbox-poller/src/main.ts
git commit -m "feat(outbox-poller): correlate per-row publish + structured logs"
```

---

### Task 5: Kafka consumers — per-message context + structured logs

**Files:**
- Modify: `apps/projection-worker/src/main.ts` (`runConsumer`, `runDispatchConsumer`)
- Modify: `apps/telemetry-worker/src/main.ts`
- Modify: `apps/read-api/src/**` (the SSE feeder consumer)

**Interfaces:**
- Consumes: `runWithObsContext`, `createLogger`; `readEnvelope` returns an envelope with `correlationId` (Task 2).

- [ ] **Step 1: Wrap each `eachMessage`**

For every `eachMessage` that calls `readEnvelope`, bind the context around the handler. Example for `apps/projection-worker/src/main.ts` `runConsumer`:

```ts
import { runWithObsContext, createLogger } from "@flashbite/shared";
const log = createLogger("projection-worker");
// inside eachMessage, after readEnvelope:
      const envelope = await readEnvelope(registry, message);
      if (!envelope) return;
      await runWithObsContext(
        { correlationId: envelope.correlationId, tenantId: envelope.tenantId, eventId: envelope.eventId },
        async () => { await applyEvent(db, envelope); log.info({ eventType: envelope.eventType }, "projected"); },
      );
```

Apply the identical wrapper to: `runDispatchConsumer` (same file, calling `applyDispatchEvent`), the telemetry-worker consumer (`apps/telemetry-worker/src/main.ts`), and the read-api SSE feeder consumer (grep `readEnvelope` / `eachMessage` under `apps/read-api/src`). Use a `createLogger` named for each app (`telemetry-worker`, `read-api`).

- [ ] **Step 2: Replace remaining console in those main.ts files**

Swap the `console.log("... running")` / `console.error(err)` in projection-worker and telemetry-worker `main.ts` for the app's `createLogger`.

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit -p apps/projection-worker/tsconfig.json && npx tsc --noEmit -p apps/telemetry-worker/tsconfig.json && npx tsc --noEmit -p apps/read-api/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/projection-worker/src/main.ts apps/telemetry-worker/src/main.ts apps/read-api/src
git commit -m "feat(consumers): per-message correlation context + structured logs"
```

---

### Task 6: Saga — forward correlationId through the workflow

**Files:**
- Modify: `apps/saga-worker/src/main.ts` (`startOrderConsumer`: bind context + pass correlationId into the workflow start args)
- Modify: `apps/saga-worker/src/workflows.ts` (`OrderLifecycleArgs` += `correlationId`; pass to activities)
- Modify: `apps/saga-worker/src/dispatch-workflow.ts` (`DispatchArgs` += `correlationId`)
- Modify: `apps/saga-worker/src/activities.ts` (pass `correlationId` to `appendWithExpectedVersion`, lines ~35 and ~49)
- Modify: `apps/saga-worker/src/dispatch-activities.ts` (pass `correlationId` at ~line 33)

**Interfaces:**
- Consumes: `AppendArgs.correlationId?` (Task 2); `readEnvelope` correlationId; `runWithObsContext` (Task 1).
- Produces: events appended by the saga carry the originating order's `correlationId`.

> Read each saga file before editing — Temporal workflow code is order/determinism sensitive. `correlationId` is a plain string, safe to add to workflow args.

- [ ] **Step 1: startOrderConsumer passes correlationId + binds context**

In `apps/saga-worker/src/main.ts` `startOrderConsumer`, after `readEnvelope`, wrap handling in `runWithObsContext` and include `correlationId: envelope.correlationId` in the args passed to `client.workflow.start(orderLifecycleWorkflow, { args: [...] })`. Add `const log = createLogger("saga-worker")` and a `log.info` line.

- [ ] **Step 2: Thread through the order workflow**

In `apps/saga-worker/src/workflows.ts`: add `correlationId: string` to `OrderLifecycleArgs`; pass `args.correlationId` into each activity call that ultimately appends (the accept/cancel activities).

- [ ] **Step 3: Thread through the dispatch workflow**

In `apps/saga-worker/src/dispatch-workflow.ts`: add `correlationId: string` to `DispatchArgs`; when the order workflow `executeChild`s the dispatch workflow, pass its `correlationId` down.

- [ ] **Step 4: Activities pass correlationId to the store**

In `apps/saga-worker/src/activities.ts` (the two `appendWithExpectedVersion(prisma, {...})` calls) and `apps/saga-worker/src/dispatch-activities.ts` (one call), add `correlationId` to the activity input type and include `correlationId: input.correlationId` in the `appendWithExpectedVersion` args object.

- [ ] **Step 5: Verify build + existing saga unit tests**

Run: `npx tsc --noEmit -p apps/saga-worker/tsconfig.json && npx jest apps/saga-worker`
Expected: build clean; existing saga unit tests pass (update any test that constructs `OrderLifecycleArgs`/`DispatchArgs` to include `correlationId: "test"`).

- [ ] **Step 6: Commit**

```bash
git add apps/saga-worker/src
git commit -m "feat(saga): forward originating order correlationId into appended events"
```

---

### Task 7: Replace remaining service `console.*`

**Files:**
- Modify: `apps/write-api/src/main.ts`, `apps/read-api/src/main.ts`, `apps/identity/src/main.ts`, `apps/payments/src/main.ts`, `apps/payments/src/payments.service.ts`

**Interfaces:** Consumes `createLogger` (Task 1).

> Scope reminder (Global Constraints): leave the CLI scripts (`seed*.ts`, `rebuild.ts`, `register.ts`) on `console.*`. This task is the running services only.

- [ ] **Step 1: Swap each call site**

In each file, add `const log = createLogger("<app>")` at module scope and replace `console.log(...)` → `log.info(...)`, `console.error(err)` → `log.error({ err }, "...")`, `console.warn` → `log.warn`. In `payments.service.ts`, attach the existing decision context to the log object (e.g., `log.info({ orderId, decision }, "payment decision")`).

- [ ] **Step 2: Verify no service console.* remains**

Run: `grep -rn "console\.\(log\|error\|warn\|info\)" apps/{write-api,read-api,identity,payments,outbox-poller,projection-worker,telemetry-worker,saga-worker}/src --include="*.ts" | grep -v spec | grep -vE "seed|rebuild|register"`
Expected: no output (CLI scripts excluded).

- [ ] **Step 3: Verify builds**

Run: `npx tsc --noEmit -p apps/write-api/tsconfig.json && npx tsc --noEmit -p apps/payments/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/write-api/src/main.ts apps/read-api/src/main.ts apps/identity/src/main.ts apps/payments/src/main.ts apps/payments/src/payments.service.ts
git commit -m "refactor: replace service console.* with structured logger"
```

---

### Task 8: Live e2e + docs

**Files:**
- Create (test): `apps/write-api/test/correlation.e2e-spec.ts` (or nearest existing e2e location)
- Modify: `README.md` (Observability section + `LOG_LEVEL` env), `docs/ARCHITECTURE.md` (Observability subsection), `.env.example` (note `LOG_LEVEL` — **do not edit if blocked; instead document in README**)

- [ ] **Step 1: Write the live e2e**

Create `apps/write-api/test/correlation.e2e-spec.ts`. With infra up, place an order via write-api carrying `x-correlation-id: e2e-corr-<unique>`, then assert the same id appears on the resulting `outbox` row's stored envelope (query Postgres) — the persisted envelope is the source the poller publishes from, so this proves propagation without a live Kafka consume:

```ts
import request from "supertest";
import { PrismaClient } from "@prisma/client";
// boot the write-api Nest app the same way the existing write-api e2e specs do (copy their setup),
// then:
it("propagates an inbound correlationId onto the persisted event envelope", async () => {
  const corr = `e2e-corr-${Date.now()}`;
  const res = await request(app.getHttpServer())
    .post("/orders")
    .set("Authorization", `Bearer ${customerToken}`)
    .set("x-correlation-id", corr)
    .send(placeOrderPayload());
  expect(res.status).toBe(201);
  const prisma = new PrismaClient();
  const row = await prisma.outbox.findFirst({ where: { id: res.body.orderId }, orderBy: { createdAt: "desc" } });
  expect((row!.payload as any).correlationId).toBe(corr);
  await prisma.$disconnect();
});
```

> Follow the existing `apps/write-api/test/*.e2e-spec.ts` for app bootstrap, token minting, and `placeOrderPayload` helper. Reuse those helpers rather than inlining.

- [ ] **Step 2: Run the e2e (infra up)**

Run: `pnpm bootstrap` (if not already up) then `npx jest apps/write-api/test/correlation.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 3: Docs — Observability section**

Add an **Observability** section to `README.md` and a subsection to `docs/ARCHITECTURE.md` covering: structured JSON logs to stdout (pino), `LOG_LEVEL` env (default `info`), how every line carries `service` + `correlationId` (+ `tenantId`/`eventId`), how to **grep one `correlationId`** across `pnpm dev` output to trace an order end-to-end, and that the live UIs are Temporal :8080 (saga timelines) + Redpanda Console :8085 (topics/consumer groups). Add `LOG_LEVEL` to the README env-vars table.

- [ ] **Step 4: Full suite + commit**

```bash
pnpm test
git add README.md docs/ARCHITECTURE.md apps/write-api/test/correlation.e2e-spec.ts
git commit -m "test(observability): correlationId e2e + docs Observability section"
```

---

## Self-Review

- **Spec coverage:** logger+ALS (T1) ✓; correlationId on envelope+headers, no migration, lenient parse (T2) ✓; HTTP mint/ingest + request log all endpoints (T3) ✓; write path stamps via buildEnvelope/obsContext (T2+T3) ✓; outbox emits header (T2+T4) ✓; consumers bind context (T5) ✓; saga forwards chain (T6) ✓; replace console.* (T4/T5/T7) ✓; docs + UIs (T8) ✓; unit serde/mixin + live e2e (T1/T2/T8) ✓; YAGNI no metrics (Global Constraints) ✓.
- **Type consistency:** `ObsContext`, `runWithObsContext`, `getObsContext`, `obsLogFields`, `newCorrelationId`, `createLogger`, `EventEnvelope.correlationId`, `AppendArgs.correlationId?`, `EnvelopeMeta.correlationId` used consistently across tasks.
- **Placeholders:** integration tasks (T5/T6/T8) reference real symbols/files found in the codebase; saga/e2e steps instruct "read the file / reuse existing helpers" rather than inventing code for order-sensitive Temporal/e2e bootstrap — intentional, with exact file paths and line anchors.
