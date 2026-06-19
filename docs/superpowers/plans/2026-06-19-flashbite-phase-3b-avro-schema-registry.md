# Phase 3b — Avro + Schema Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JSON Kafka envelopes with Confluent-Avro (payload-only value + envelope metadata in headers) serialized through Redpanda's Schema Registry, with explicit schema registration, lookup-only producers, and enforced BACKWARD compatibility.

**Architecture:** A new `@flashbite/messaging` package owns the registry client and the serde/header/publish/consume helpers. Avro `.avsc` files and a pure subject map live in `@flashbite/contracts`. The 2 produce sites encode the payload + set headers via `publishEnvelope`; the 4 consume sites decode + parse headers via `readEnvelope`, reconstructing the existing `EventEnvelope` so downstream handlers are unchanged. Schemas are registered explicitly (`pnpm register:schemas`); producers never auto-register. Hard cut — no JSON fallback.

**Tech Stack:** kafkajs, `@kafkajs/confluent-schema-registry` (Confluent wire format + `avsc`), Redpanda Schema Registry (`localhost:18081`), TypeScript, Jest/ts-jest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-19-flashbite-phase-3b-avro-schema-registry-design.md`

---

## Conventions (read once)

- Packages are **TS-source** (`"main": "src/index.ts"`, no build step). A new package must be registered in **both** `tsconfig.base.json` `paths` and `jest.config.cjs` `paths`, and added as a `workspace:*` dependency to each consuming package.
- Tests run with `pnpm jest` (root). **e2e tests require live infra** (`pnpm infra:up`): Postgres, Mongo, Redis Cluster, Redpanda (Kafka `localhost:9092` + Schema Registry `localhost:18081`). Unit tests need no infra.
- Verify the full backend suite with `pnpm jest`. Typecheck per app/package is via `pnpm exec tsc -p <path> --noEmit` where a tsconfig exists.
- Schema Registry host comes from `SCHEMA_REGISTRY_URL` (default `http://localhost:18081`).
- `@kafkajs/confluent-schema-registry` API used: `new SchemaRegistry({ host })`, `registry.register({ type: SchemaType.AVRO, schema: JSON.stringify(avsc) }, { subject })` → `{ id }` (throws on incompatibility), `registry.getLatestSchemaId(subject)` → `number` (throws if absent), `registry.encode(id, payload)` → `Buffer`, `registry.decode(buffer)` → decoded value. Subject compatibility is **not** in the lib → set via REST `PUT {host}/config/{subject}`.

---

## Task 1: Scaffold `@flashbite/messaging` + config + env

**Files:**
- Create: `packages/messaging/package.json`
- Create: `packages/messaging/tsconfig.json`
- Create: `packages/messaging/src/index.ts`
- Modify: `tsconfig.base.json` (paths)
- Modify: `jest.config.cjs` (paths)
- Modify: `packages/shared/src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Create `packages/messaging/package.json`**

```json
{
  "name": "@flashbite/messaging",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@kafkajs/confluent-schema-registry": "^3.3.0",
    "@flashbite/contracts": "workspace:*"
  },
  "peerDependencies": {
    "kafkajs": "2.2.4"
  },
  "devDependencies": {
    "kafkajs": "2.2.4"
  }
}
```

> Note: pin `kafkajs` to the version already used in the repo. If `apps/*` use a different exact version, match it — run `grep -rh '"kafkajs"' apps packages | sort -u` and use that exact string in `peerDependencies` and `devDependencies`.

- [ ] **Step 2: Create `packages/messaging/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/messaging/src/index.ts` (placeholder, expanded later)**

```ts
export {};
```

- [ ] **Step 4: Register the path in `tsconfig.base.json`**

Add to `compilerOptions.paths` (after the `@flashbite/shared` entry):

```json
"@flashbite/messaging": ["packages/messaging/src/index.ts"],
```

- [ ] **Step 5: Register the path in `jest.config.cjs`**

Add to the `paths` object (after the `@flashbite/shared` entry):

```js
"@flashbite/messaging": ["packages/messaging/src/index.ts"],
```

- [ ] **Step 6: Add `schemaRegistryUrl` to `packages/shared/src/config.ts`**

In `interface AppConfig`, add after `kafkaBrokers`:

```ts
  schemaRegistryUrl: string;
```

In the `loadConfig` return object, add after `kafkaBrokers`:

```ts
    schemaRegistryUrl: env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081",
```

- [ ] **Step 7: Document the env var in `.env.example`**

Add near the `KAFKA_BROKERS` line:

```
# Redpanda Schema Registry (Avro). Default matches infra/docker-compose.yml.
SCHEMA_REGISTRY_URL=http://localhost:18081
```

- [ ] **Step 8: Install and verify wiring**

Run: `pnpm install`
Expected: installs `@kafkajs/confluent-schema-registry`; lockfile updates; no errors.

Run: `pnpm exec tsc -p packages/messaging/tsconfig.json --noEmit`
Expected: PASS (empty package compiles).

Run: `pnpm exec tsc -p packages/shared/tsconfig.json --noEmit`
Expected: PASS (config change typechecks).

- [ ] **Step 9: Commit**

```bash
git add packages/messaging tsconfig.base.json jest.config.cjs packages/shared/src/config.ts .env.example pnpm-lock.yaml package.json
git commit -m "feat(messaging): scaffold @flashbite/messaging package + schemaRegistryUrl config"
```

---

## Task 2: `headers.ts` — envelope metadata ↔ Kafka headers

**Files:**
- Create: `packages/messaging/src/headers.ts`
- Create: `packages/messaging/src/headers.spec.ts`
- Modify: `packages/messaging/src/index.ts`

- [ ] **Step 1: Write the failing test `packages/messaging/src/headers.spec.ts`**

```ts
import { buildHeaders, parseHeaders } from "./headers";

describe("messaging headers", () => {
  const meta = {
    tenantId: "berlin",
    eventId: "evt-1",
    eventType: "OrderPlaced",
    version: 3,
    occurredAt: "2026-06-19T00:00:00.000Z",
  };

  it("round-trips metadata through string headers", () => {
    const headers = buildHeaders(meta);
    expect(headers).toEqual({
      eventType: "OrderPlaced",
      tenantId: "berlin",
      eventId: "evt-1",
      version: "3",
      occurredAt: "2026-06-19T00:00:00.000Z",
    });
    // kafkajs delivers header values as Buffers
    const asBuffers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)]));
    expect(parseHeaders(asBuffers)).toEqual(meta);
  });

  it("coerces version to a number and defaults missing headers to empty", () => {
    expect(parseHeaders(undefined)).toEqual({ eventType: "", tenantId: "", eventId: "", version: 0, occurredAt: "" });
    expect(parseHeaders({ version: Buffer.from("7") }).version).toBe(7);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest packages/messaging/src/headers.spec.ts`
Expected: FAIL — cannot find module `./headers`.

- [ ] **Step 3: Implement `packages/messaging/src/headers.ts`**

```ts
import type { IHeaders } from "kafkajs";
import type { EventEnvelope } from "@flashbite/contracts";

/** Envelope minus its payload — the metadata carried in Kafka headers. */
export type EnvelopeMeta = Omit<EventEnvelope, "payload">;

/** Serializes envelope metadata to string Kafka headers. */
export function buildHeaders(meta: EnvelopeMeta): Record<string, string> {
  return {
    eventType: meta.eventType,
    tenantId: meta.tenantId,
    eventId: meta.eventId,
    version: String(meta.version),
    occurredAt: meta.occurredAt,
  };
}

/** Reconstructs envelope metadata from Kafka headers (values arrive as Buffers). */
export function parseHeaders(headers: IHeaders | undefined): EnvelopeMeta {
  const h = headers ?? {};
  const s = (k: string): string => (h[k] == null ? "" : h[k]!.toString());
  return {
    eventType: s("eventType"),
    tenantId: s("tenantId"),
    eventId: s("eventId"),
    version: Number(s("version") || 0),
    occurredAt: s("occurredAt"),
  };
}
```

- [ ] **Step 4: Export from `packages/messaging/src/index.ts`**

Replace the file contents with:

```ts
export * from "./headers";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm jest packages/messaging/src/headers.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/messaging/src/headers.ts packages/messaging/src/headers.spec.ts packages/messaging/src/index.ts
git commit -m "feat(messaging): header serde for envelope metadata"
```

---

## Task 3: Avro schemas + subject map in `@flashbite/contracts` + loader

**Files:**
- Create: `packages/contracts/avro/order-placed.avsc`
- Create: `packages/contracts/avro/order-accepted.avsc`
- Create: `packages/contracts/avro/order-cancelled.avsc`
- Create: `packages/contracts/avro/driver-telemetry.avsc`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/subjects.spec.ts`
- Create: `packages/messaging/src/schemas.ts`
- Create: `packages/messaging/src/schemas.spec.ts`
- Modify: `packages/messaging/src/index.ts`

- [ ] **Step 1: Create the four `.avsc` files**

`packages/contracts/avro/order-placed.avsc`:

```json
{
  "type": "record",
  "name": "OrderPlaced",
  "namespace": "com.flashbite.events",
  "fields": [
    { "name": "orderId", "type": "string" },
    { "name": "customerId", "type": "string" },
    {
      "name": "items",
      "type": {
        "type": "array",
        "items": {
          "type": "record",
          "name": "OrderItem",
          "fields": [
            { "name": "sku", "type": "string" },
            { "name": "qty", "type": "int" },
            { "name": "price", "type": "double" }
          ]
        }
      }
    },
    { "name": "totalAmount", "type": "double" }
  ]
}
```

`packages/contracts/avro/order-accepted.avsc`:

```json
{
  "type": "record",
  "name": "OrderAccepted",
  "namespace": "com.flashbite.events",
  "fields": [{ "name": "orderId", "type": "string" }]
}
```

`packages/contracts/avro/order-cancelled.avsc`:

```json
{
  "type": "record",
  "name": "OrderCancelled",
  "namespace": "com.flashbite.events",
  "fields": [
    { "name": "orderId", "type": "string" },
    { "name": "reason", "type": "string" }
  ]
}
```

`packages/contracts/avro/driver-telemetry.avsc`:

```json
{
  "type": "record",
  "name": "DriverTelemetry",
  "namespace": "com.flashbite.events",
  "fields": [
    { "name": "driverId", "type": "string" },
    { "name": "orderId", "type": ["null", "string"], "default": null },
    { "name": "lng", "type": "double" },
    { "name": "lat", "type": "double" }
  ]
}
```

- [ ] **Step 2: Write the failing subject test `packages/contracts/src/subjects.spec.ts`**

```ts
import { AVRO_NAMESPACE, SUBJECTS, subjectFor, EVENT_TYPES, TOPICS } from "./index";

describe("avro subjects", () => {
  it("computes TopicRecordNameStrategy subjects", () => {
    expect(AVRO_NAMESPACE).toBe("com.flashbite.events");
    expect(subjectFor(TOPICS.ORDER_EVENTS, "OrderPlaced")).toBe(
      "order-events-com.flashbite.events.OrderPlaced",
    );
  });

  it("has one subject entry per event type, mapped to the right topic", () => {
    const byType = Object.fromEntries(SUBJECTS.map((s) => [s.eventType, s]));
    expect(byType[EVENT_TYPES.ORDER_PLACED].topic).toBe(TOPICS.ORDER_EVENTS);
    expect(byType[EVENT_TYPES.ORDER_ACCEPTED].topic).toBe(TOPICS.ORDER_EVENTS);
    expect(byType[EVENT_TYPES.ORDER_CANCELLED].topic).toBe(TOPICS.ORDER_EVENTS);
    expect(byType[EVENT_TYPES.DRIVER_TELEMETRY_STREAMED].topic).toBe(TOPICS.TELEMETRY_STREAMS);
    expect(SUBJECTS).toHaveLength(4);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm jest packages/contracts/src/subjects.spec.ts`
Expected: FAIL — `AVRO_NAMESPACE`/`SUBJECTS`/`subjectFor` not exported.

- [ ] **Step 4: Add the subject map to `packages/contracts/src/index.ts`**

Add at the end of the `// ---- Messaging ----` section (after `CONSUMER_GROUPS`):

```ts
/** Avro record namespace; the record fullname feeds TopicRecordNameStrategy subjects. */
export const AVRO_NAMESPACE = "com.flashbite.events";

/** One Avro subject per event type. avsc = filename under packages/contracts/avro/. */
export const SUBJECTS = [
  { eventType: EVENT_TYPES.ORDER_PLACED, topic: TOPICS.ORDER_EVENTS, recordName: "OrderPlaced", avsc: "order-placed.avsc" },
  { eventType: EVENT_TYPES.ORDER_ACCEPTED, topic: TOPICS.ORDER_EVENTS, recordName: "OrderAccepted", avsc: "order-accepted.avsc" },
  { eventType: EVENT_TYPES.ORDER_CANCELLED, topic: TOPICS.ORDER_EVENTS, recordName: "OrderCancelled", avsc: "order-cancelled.avsc" },
  { eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED, topic: TOPICS.TELEMETRY_STREAMS, recordName: "DriverTelemetry", avsc: "driver-telemetry.avsc" },
] as const;

/** Subject name = `${topic}-${namespace}.${recordName}` (TopicRecordNameStrategy). */
export function subjectFor(topic: string, recordName: string): string {
  return `${topic}-${AVRO_NAMESPACE}.${recordName}`;
}
```

- [ ] **Step 5: Run the subject test to verify it passes**

Run: `pnpm jest packages/contracts/src/subjects.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the failing loader test `packages/messaging/src/schemas.spec.ts`**

```ts
import { loadAvsc } from "./schemas";
import { SUBJECTS } from "@flashbite/contracts";

describe("avsc loader", () => {
  it("loads every subject's schema with matching record name + namespace", () => {
    for (const s of SUBJECTS) {
      const schema = loadAvsc(s.avsc) as { name: string; namespace: string; type: string };
      expect(schema.type).toBe("record");
      expect(schema.name).toBe(s.recordName);
      expect(schema.namespace).toBe("com.flashbite.events");
    }
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm jest packages/messaging/src/schemas.spec.ts`
Expected: FAIL — cannot find module `./schemas`.

- [ ] **Step 8: Implement `packages/messaging/src/schemas.ts`**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

// .avsc files live in @flashbite/contracts/avro. Resolved relative to this source
// file (packages/messaging/src → packages/contracts/avro); the repo runs from source.
const AVRO_DIR = path.join(__dirname, "..", "..", "contracts", "avro");

/** Reads and parses an .avsc file from @flashbite/contracts/avro. */
export function loadAvsc(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(AVRO_DIR, file), "utf8"));
}
```

- [ ] **Step 9: Export from `packages/messaging/src/index.ts`**

Replace contents with:

```ts
export * from "./headers";
export * from "./schemas";
```

- [ ] **Step 10: Run the loader test to verify it passes**

Run: `pnpm jest packages/messaging/src/schemas.spec.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/contracts/avro packages/contracts/src/index.ts packages/contracts/src/subjects.spec.ts packages/messaging/src/schemas.ts packages/messaging/src/schemas.spec.ts packages/messaging/src/index.ts
git commit -m "feat(contracts,messaging): Avro schemas + subject map + avsc loader"
```

---

## Task 4: `serde.ts` — encode/decode + cached schema-id lookup (lookup-only)

**Files:**
- Create: `packages/messaging/src/serde.ts`
- Create: `packages/messaging/src/serde.spec.ts`
- Modify: `packages/messaging/src/index.ts`

- [ ] **Step 1: Write the failing test `packages/messaging/src/serde.spec.ts`**

```ts
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { encodePayload, decodePayload, resolveSchemaId, __resetIdCache } from "./serde";

function fakeRegistry(over: Partial<SchemaRegistry> = {}): SchemaRegistry {
  return {
    getLatestSchemaId: jest.fn(async () => 42),
    encode: jest.fn(async (_id: number, _payload: unknown) => Buffer.from("avro")),
    decode: jest.fn(async (_buf: Buffer) => ({ orderId: "o-1" })),
    ...over,
  } as unknown as SchemaRegistry;
}

describe("serde", () => {
  beforeEach(() => __resetIdCache());

  it("resolves and caches the schema id per subject", async () => {
    const reg = fakeRegistry();
    await resolveSchemaId(reg, "s");
    await resolveSchemaId(reg, "s");
    expect(reg.getLatestSchemaId).toHaveBeenCalledTimes(1);
  });

  it("encodes the payload at the resolved id", async () => {
    const reg = fakeRegistry();
    const buf = await encodePayload(reg, "s", { orderId: "o-1" });
    expect(reg.encode).toHaveBeenCalledWith(42, { orderId: "o-1" });
    expect(buf).toEqual(Buffer.from("avro"));
  });

  it("decodes a buffer to its payload", async () => {
    const reg = fakeRegistry();
    expect(await decodePayload(reg, Buffer.from("avro"))).toEqual({ orderId: "o-1" });
  });

  it("throws (lookup-only) when the subject is not registered", async () => {
    const reg = fakeRegistry({ getLatestSchemaId: jest.fn(async () => { throw new Error("not found"); }) as never });
    await expect(resolveSchemaId(reg, "missing")).rejects.toThrow("not found");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest packages/messaging/src/serde.spec.ts`
Expected: FAIL — cannot find module `./serde`.

- [ ] **Step 3: Implement `packages/messaging/src/serde.ts`**

```ts
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";

const idCache = new Map<string, number>();

/**
 * Resolves the latest registered schema id for a subject (cached). Producers are
 * lookup-only: this NEVER registers, and throws if the subject is unregistered.
 */
export async function resolveSchemaId(registry: SchemaRegistry, subject: string): Promise<number> {
  const hit = idCache.get(subject);
  if (hit != null) return hit;
  const id = await registry.getLatestSchemaId(subject);
  idCache.set(subject, id);
  return id;
}

/** Avro-encodes a payload to Confluent wire format using the subject's latest schema. */
export async function encodePayload(registry: SchemaRegistry, subject: string, payload: unknown): Promise<Buffer> {
  return registry.encode(await resolveSchemaId(registry, subject), payload);
}

/** Decodes a Confluent-Avro buffer (schema fetched by id from the wire bytes). */
export async function decodePayload<T = unknown>(registry: SchemaRegistry, value: Buffer): Promise<T> {
  return registry.decode(value) as Promise<T>;
}

/** Test seam: clears the schema-id cache. */
export function __resetIdCache(): void {
  idCache.clear();
}
```

- [ ] **Step 4: Export from `packages/messaging/src/index.ts`**

Replace contents with:

```ts
export * from "./headers";
export * from "./schemas";
export * from "./serde";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm jest packages/messaging/src/serde.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/messaging/src/serde.ts packages/messaging/src/serde.spec.ts packages/messaging/src/index.ts
git commit -m "feat(messaging): Avro serde with cached lookup-only schema ids"
```

---

## Task 5: `registry.ts` + `register.ts` — explicit registration + BACKWARD compatibility + CLI

**Files:**
- Create: `packages/messaging/src/registry.ts`
- Create: `packages/messaging/src/register.ts`
- Create: `packages/messaging/test/register.e2e-spec.ts`
- Modify: `packages/messaging/src/index.ts`
- Modify: `package.json` (root — `register:schemas` script)

- [ ] **Step 1: Implement `packages/messaging/src/registry.ts`**

```ts
import { SchemaRegistry } from "@kafkajs/confluent-schema-registry";

/** Creates a Schema Registry client. */
export function createRegistry(url: string): SchemaRegistry {
  return new SchemaRegistry({ host: url });
}
```

- [ ] **Step 2: Implement `packages/messaging/src/register.ts`**

```ts
import { SchemaType } from "@kafkajs/confluent-schema-registry";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { SUBJECTS, subjectFor } from "@flashbite/contracts";
import { createRegistry } from "./registry";
import { loadAvsc } from "./schemas";

const SR_CONTENT_TYPE = "application/vnd.schemaregistry.v1+json";

/** Sets a subject's compatibility level via the registry REST API (not in the client lib). */
export async function setCompatibility(host: string, subject: string, level: string): Promise<void> {
  const res = await fetch(`${host}/config/${encodeURIComponent(subject)}`, {
    method: "PUT",
    headers: { "Content-Type": SR_CONTENT_TYPE },
    body: JSON.stringify({ compatibility: level }),
  });
  if (!res.ok) throw new Error(`set compatibility ${subject}=${level} failed: ${res.status} ${await res.text()}`);
}

/** Registers all SUBJECTS at BACKWARD compatibility. Throws on an incompatible schema. */
export async function registerAllSchemas(registry: SchemaRegistry, host: string): Promise<void> {
  for (const s of SUBJECTS) {
    const subject = subjectFor(s.topic, s.recordName);
    await setCompatibility(host, subject, "BACKWARD");
    const { id } = await registry.register(
      { type: SchemaType.AVRO, schema: JSON.stringify(loadAvsc(s.avsc)) },
      { subject },
    );
    // eslint-disable-next-line no-console
    console.log(`registered ${subject} -> id ${id}`);
  }
}

async function main(): Promise<void> {
  const host = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";
  await registerAllSchemas(createRegistry(host), host);
  // eslint-disable-next-line no-console
  console.log("schema registration complete");
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Export from `packages/messaging/src/index.ts`**

Replace contents with:

```ts
export * from "./headers";
export * from "./schemas";
export * from "./serde";
export * from "./registry";
export * from "./register";
```

- [ ] **Step 4: Add the root `register:schemas` script**

In root `package.json` `scripts`, add after `"seed:users"`:

```json
"register:schemas": "node -r @swc-node/register -r tsconfig-paths/register packages/messaging/src/register.ts",
```

- [ ] **Step 5: Write the live registration e2e `packages/messaging/test/register.e2e-spec.ts`**

```ts
import { SUBJECTS, subjectFor } from "@flashbite/contracts";
import { createRegistry, registerAllSchemas } from "../src/register";

const HOST = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";

describe("schema registration (live registry)", () => {
  it("registers all subjects so producers can resolve their ids", async () => {
    const registry = createRegistry(HOST);
    await registerAllSchemas(registry, HOST);
    for (const s of SUBJECTS) {
      const id = await registry.getLatestSchemaId(subjectFor(s.topic, s.recordName));
      expect(typeof id).toBe("number");
    }
  });
});
```

- [ ] **Step 6: Run it (requires `pnpm infra:up`)**

Run: `pnpm jest packages/messaging/test/register.e2e-spec.ts`
Expected: PASS — logs `registered ...` lines; all ids resolve.

- [ ] **Step 7: Commit**

```bash
git add packages/messaging/src/registry.ts packages/messaging/src/register.ts packages/messaging/test/register.e2e-spec.ts packages/messaging/src/index.ts package.json
git commit -m "feat(messaging): explicit schema registration + BACKWARD compat + register:schemas"
```

---

## Task 6: Compatibility-rejection test (proves the registry has teeth)

**Files:**
- Create: `packages/messaging/test/compatibility.e2e-spec.ts`

- [ ] **Step 1: Write the test `packages/messaging/test/compatibility.e2e-spec.ts`**

```ts
import { SchemaType } from "@kafkajs/confluent-schema-registry";
import { createRegistry, setCompatibility } from "../src/register";

const HOST = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";

// A throwaway subject so we never disturb the real ones.
const SUBJECT = "flashbite-compat-probe-value";
const NS = "com.flashbite.probe";

const base = {
  type: "record",
  name: "Probe",
  namespace: NS,
  fields: [{ name: "id", type: "string" }],
};

// BACKWARD-incompatible: a new REQUIRED field with no default (a new-schema reader
// cannot read data written by the old schema).
const incompatible = {
  ...base,
  fields: [...base.fields, { name: "mustHave", type: "string" }],
};

// BACKWARD-compatible: a new OPTIONAL field with a default.
const compatible = {
  ...base,
  fields: [...base.fields, { name: "note", type: ["null", "string"], default: null }],
};

describe("schema compatibility enforcement (live registry)", () => {
  const registry = createRegistry(HOST);

  beforeAll(async () => {
    await setCompatibility(HOST, SUBJECT, "BACKWARD");
    await registry.register({ type: SchemaType.AVRO, schema: JSON.stringify(base) }, { subject: SUBJECT });
  });

  it("rejects a BACKWARD-incompatible change", async () => {
    await expect(
      registry.register({ type: SchemaType.AVRO, schema: JSON.stringify(incompatible) }, { subject: SUBJECT }),
    ).rejects.toThrow();
  });

  it("accepts a BACKWARD-compatible change", async () => {
    const { id } = await registry.register(
      { type: SchemaType.AVRO, schema: JSON.stringify(compatible) },
      { subject: SUBJECT },
    );
    expect(typeof id).toBe("number");
  });
});
```

- [ ] **Step 2: Run it (requires `pnpm infra:up`)**

Run: `pnpm jest packages/messaging/test/compatibility.e2e-spec.ts`
Expected: PASS (2 tests) — incompatible rejected, compatible accepted.

- [ ] **Step 3: Commit**

```bash
git add packages/messaging/test/compatibility.e2e-spec.ts
git commit -m "test(messaging): prove BACKWARD compatibility is enforced"
```

---

## Task 7: `publish.ts` + `consume.ts` — the shared produce/consume helpers

**Files:**
- Create: `packages/messaging/src/publish.ts`
- Create: `packages/messaging/src/consume.ts`
- Create: `packages/messaging/src/publish.spec.ts`
- Modify: `packages/messaging/src/index.ts`

- [ ] **Step 1: Write the failing test `packages/messaging/src/publish.spec.ts`**

```ts
import type { Producer } from "kafkajs";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { TOPICS, EVENT_TYPES, type EventEnvelope } from "@flashbite/contracts";
import { publishEnvelope } from "./publish";
import { readEnvelope } from "./consume";
import { __resetIdCache } from "./serde";

const envelope: EventEnvelope = {
  tenantId: "berlin",
  eventId: "evt-1",
  eventType: EVENT_TYPES.ORDER_PLACED,
  version: 1,
  occurredAt: "2026-06-19T00:00:00.000Z",
  payload: { orderId: "o-1", customerId: "c-1", items: [], totalAmount: 0 },
};

describe("publish/consume helpers", () => {
  beforeEach(() => __resetIdCache());

  it("encodes the payload and sends value + metadata headers", async () => {
    const registry = {
      getLatestSchemaId: jest.fn(async () => 7),
      encode: jest.fn(async () => Buffer.from("avro")),
    } as unknown as SchemaRegistry;
    const producer = { send: jest.fn(async () => undefined) } as unknown as Producer;

    await publishEnvelope(producer, registry, TOPICS.ORDER_EVENTS, "berlin:o-1", envelope);

    expect(registry.encode).toHaveBeenCalledWith(7, envelope.payload);
    expect(producer.send).toHaveBeenCalledWith({
      topic: TOPICS.ORDER_EVENTS,
      messages: [
        {
          key: "berlin:o-1",
          value: Buffer.from("avro"),
          headers: {
            eventType: EVENT_TYPES.ORDER_PLACED,
            tenantId: "berlin",
            eventId: "evt-1",
            version: "1",
            occurredAt: "2026-06-19T00:00:00.000Z",
          },
        },
      ],
    });
  });

  it("throws for an event type without a registered subject", async () => {
    const registry = {} as SchemaRegistry;
    const producer = { send: jest.fn() } as unknown as Producer;
    await expect(
      publishEnvelope(producer, registry, TOPICS.ORDER_EVENTS, "k", { ...envelope, eventType: "Nope" }),
    ).rejects.toThrow(/No Avro subject/);
  });

  it("reassembles the envelope from headers + decoded payload", async () => {
    const registry = { decode: jest.fn(async () => envelope.payload) } as unknown as SchemaRegistry;
    const message = {
      value: Buffer.from("avro"),
      headers: {
        eventType: Buffer.from(EVENT_TYPES.ORDER_PLACED),
        tenantId: Buffer.from("berlin"),
        eventId: Buffer.from("evt-1"),
        version: Buffer.from("1"),
        occurredAt: Buffer.from("2026-06-19T00:00:00.000Z"),
      },
    };
    const result = await readEnvelope(registry, message as never);
    expect(result).toEqual(envelope);
  });

  it("returns null for a message with no value", async () => {
    const registry = {} as SchemaRegistry;
    expect(await readEnvelope(registry, { value: null } as never)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest packages/messaging/src/publish.spec.ts`
Expected: FAIL — cannot find module `./publish`.

- [ ] **Step 3: Implement `packages/messaging/src/publish.ts`**

```ts
import type { Producer } from "kafkajs";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { SUBJECTS, subjectFor, type EventEnvelope } from "@flashbite/contracts";
import { encodePayload } from "./serde";
import { buildHeaders } from "./headers";

/**
 * Publishes an event: Avro-encodes the payload (value) and carries the envelope
 * metadata in Kafka headers. Producers are lookup-only — encode fails loudly if
 * the subject is not registered.
 */
export async function publishEnvelope(
  producer: Producer,
  registry: SchemaRegistry,
  topic: string,
  key: string,
  envelope: EventEnvelope,
): Promise<void> {
  const entry = SUBJECTS.find((s) => s.eventType === envelope.eventType);
  if (!entry) throw new Error(`No Avro subject for eventType ${envelope.eventType}`);
  const value = await encodePayload(registry, subjectFor(topic, entry.recordName), envelope.payload);
  await producer.send({ topic, messages: [{ key, value, headers: buildHeaders(envelope) }] });
}
```

- [ ] **Step 4: Implement `packages/messaging/src/consume.ts`**

```ts
import type { KafkaMessage } from "kafkajs";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import type { EventEnvelope } from "@flashbite/contracts";
import { decodePayload } from "./serde";
import { parseHeaders } from "./headers";

/** Decodes a Kafka message into the EventEnvelope shape (headers + Avro payload). */
export async function readEnvelope(registry: SchemaRegistry, message: KafkaMessage): Promise<EventEnvelope | null> {
  if (!message.value) return null;
  const payload = await decodePayload(registry, message.value);
  return { ...parseHeaders(message.headers), payload };
}
```

- [ ] **Step 5: Export from `packages/messaging/src/index.ts`**

Replace contents with:

```ts
export * from "./headers";
export * from "./schemas";
export * from "./serde";
export * from "./registry";
export * from "./register";
export * from "./publish";
export * from "./consume";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm jest packages/messaging/src/publish.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Typecheck the whole package**

Run: `pnpm exec tsc -p packages/messaging/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/messaging/src/publish.ts packages/messaging/src/consume.ts packages/messaging/src/publish.spec.ts packages/messaging/src/index.ts
git commit -m "feat(messaging): publishEnvelope + readEnvelope helpers"
```

---

## Task 8: Migrate `order-events` producer (outbox-poller) to Avro

> Hard cut on `order-events` begins here. The poller's own e2e (this task) is
> self-contained (it produces *and* consumes Avro). The order-events *consumers*
> (Tasks 8b–8d) each have self-contained tests too. The full cross-service order
> flow is verified in Task 11.

**Files:**
- Modify: `apps/outbox-poller/src/poller.ts`
- Modify: `apps/outbox-poller/src/main.ts`
- Modify: `apps/outbox-poller/package.json` (add `@flashbite/messaging` dep)
- Modify: `apps/outbox-poller/test/poller.spec.ts`

- [ ] **Step 1: Add the workspace dep**

In `apps/outbox-poller/package.json` `dependencies`, add:

```json
"@flashbite/messaging": "workspace:*",
```

Run: `pnpm install`
Expected: links the workspace package.

- [ ] **Step 2: Rewrite `apps/outbox-poller/src/poller.ts` to publish Avro**

```ts
import type { Producer } from "kafkajs";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import type { PrismaService } from "@flashbite/shared";
import type { EventEnvelope } from "@flashbite/contracts";
import { publishEnvelope } from "@flashbite/messaging";

/**
 * Publishes all PENDING outbox rows (oldest first) to Kafka as Confluent-Avro
 * (payload value + metadata headers) and marks them SENT. At-least-once: a row
 * may publish more than once on crash between send and update — consumers dedupe
 * on the envelope eventId. Returns the number sent.
 */
export async function pollOnce(prisma: PrismaService, producer: Producer, registry: SchemaRegistry): Promise<number> {
  const pending = await prisma.outbox.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  for (const row of pending) {
    await publishEnvelope(producer, registry, row.topic, row.partitionKey, row.payload as unknown as EventEnvelope);
    await prisma.outbox.update({ where: { id: row.id }, data: { status: "SENT" } });
  }

  return pending.length;
}
```

- [ ] **Step 3: Wire the registry into `apps/outbox-poller/src/main.ts`**

Change the imports line:

```ts
import { PrismaService, loadConfig } from "@flashbite/shared";
import { createRegistry } from "@flashbite/messaging";
import { pollOnce } from "./poller";
```

After `await producer.connect();`, add:

```ts
  const registry = createRegistry(config.schemaRegistryUrl);
```

Change the poll call inside the loop:

```ts
    const sent = await pollOnce(prisma, producer, registry);
```

- [ ] **Step 4: Update the e2e `apps/outbox-poller/test/poller.spec.ts`**

Replace the whole file with:

```ts
import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { PrismaService, buildEnvelope } from "@flashbite/shared";
import { EVENT_TYPES, TOPICS, subjectFor } from "@flashbite/contracts";
import { createRegistry, registerAllSchemas, decodePayload, parseHeaders } from "@flashbite/messaging";
import { pollOnce } from "../src/poller";

const HOST = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";

describe("outbox poller (Avro)", () => {
  const prisma = new PrismaService();
  const kafka = new Kafka({ clientId: "poller-test", brokers: ["localhost:9092"], logLevel: logLevel.NOTHING });
  const registry = createRegistry(HOST);

  beforeAll(async () => {
    await prisma.$connect();
    await registerAllSchemas(registry, HOST);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("publishes PENDING rows as Avro (payload value + headers) and marks them SENT", async () => {
    const orderId = randomUUID();
    const eventId = randomUUID();
    const envelope = buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 1,
      eventId,
      payload: { orderId, customerId: "c-1", items: [{ sku: "x", qty: 1, price: 2.5 }], totalAmount: 2.5 },
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

    const admin = kafka.admin();
    await admin.connect();
    const before = await admin.fetchTopicOffsets(TOPICS.ORDER_EVENTS);
    await admin.disconnect();
    const startOffsets = new Map(before.map((w) => [w.partition, BigInt(w.high)]));

    const producer = kafka.producer();
    await producer.connect();
    const count = await pollOnce(prisma, producer, registry);
    await producer.disconnect();
    expect(count).toBeGreaterThanOrEqual(1);

    const row = await prisma.outbox.findUnique({ where: { id: eventId } });
    expect(row?.status).toBe("SENT");

    const consumer = kafka.consumer({ groupId: `poller-test-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: true });
    const received: { eventId: string; orderId: string; sku: string } = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("event not received")), 10000);
      consumer.on(consumer.events.GROUP_JOIN, () => {
        for (const [p, o] of startOffsets) consumer.seek({ topic: TOPICS.ORDER_EVENTS, partition: p, offset: o.toString() });
      });
      consumer
        .run({
          eachMessage: async ({ partition, message }) => {
            if (BigInt(message.offset) < (startOffsets.get(partition) ?? 0n)) return;
            const meta = parseHeaders(message.headers);
            if (meta.eventId !== eventId) return;
            const payload = await decodePayload<{ orderId: string; items: { sku: string }[] }>(registry, message.value!);
            clearTimeout(timer);
            resolve({ eventId: meta.eventId, orderId: payload.orderId, sku: payload.items[0].sku });
          },
        })
        .catch(reject);
    });
    await consumer.disconnect();
    expect(received.eventId).toBe(eventId);
    expect(received.orderId).toBe(orderId);
    expect(received.sku).toBe("x");
    // subject sanity
    expect(subjectFor(TOPICS.ORDER_EVENTS, "OrderPlaced")).toContain("OrderPlaced");

    await prisma.outbox.delete({ where: { id: eventId } });
  });
});
```

- [ ] **Step 5: Run the test (requires `pnpm infra:up`)**

Run: `pnpm jest apps/outbox-poller/test/poller.spec.ts`
Expected: PASS — value is Avro, metadata read from headers.

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc -p apps/outbox-poller/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/outbox-poller/src/poller.ts apps/outbox-poller/src/main.ts apps/outbox-poller/package.json apps/outbox-poller/test/poller.spec.ts pnpm-lock.yaml
git commit -m "feat(outbox-poller): publish order events as Avro via schema registry"
```

---

## Task 8b: Migrate projection-worker consumer to Avro

**Files:**
- Modify: `apps/projection-worker/src/main.ts`
- Modify: `apps/projection-worker/package.json` (add `@flashbite/messaging` dep)
- Modify: `apps/projection-worker/test/consumer.spec.ts`

- [ ] **Step 1: Add the workspace dep**

In `apps/projection-worker/package.json` `dependencies`, add `"@flashbite/messaging": "workspace:*",` then run `pnpm install`.

- [ ] **Step 2: Rewrite `runConsumer` + wire the registry in `apps/projection-worker/src/main.ts`**

Change the imports block to:

```ts
import { Kafka, logLevel, type Consumer } from "kafkajs";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import type { Db } from "mongodb";
import { connectMongo, loadConfig } from "@flashbite/shared";
import { CONSUMER_GROUPS, TOPICS } from "@flashbite/contracts";
import { createRegistry, readEnvelope } from "@flashbite/messaging";
import { applyEvent } from "./projection";
```

Replace `runConsumer` with:

```ts
/** Wires a kafkajs consumer to applyEvent (Avro decode + header metadata). */
export async function runConsumer(consumer: Consumer, db: Db, registry: SchemaRegistry): Promise<ConsumerHandle> {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const envelope = await readEnvelope(registry, message);
      if (!envelope) return;
      await applyEvent(db, envelope);
    },
  });
  return { stop: async () => { await consumer.disconnect(); } };
}
```

In `main()`, after `const consumer = kafka.consumer(...)`, change the handle line to:

```ts
  const registry = createRegistry(config.schemaRegistryUrl);
  const handle = await runConsumer(consumer, db, registry);
```

- [ ] **Step 3: Update `apps/projection-worker/test/consumer.spec.ts`**

First read the current file to see how it produces test messages. Then change it so:
1. `beforeAll` registers schemas: add
   ```ts
   import { createRegistry, registerAllSchemas, publishEnvelope } from "@flashbite/messaging";
   const HOST = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";
   const registry = createRegistry(HOST);
   ```
   and in `beforeAll`: `await registerAllSchemas(registry, HOST);`
2. Where the test currently produces a message with `producer.send({ ... value: JSON.stringify(envelope) ... })`, replace it with
   ```ts
   await publishEnvelope(producer, registry, TOPICS.ORDER_EVENTS, partitionKey, envelope);
   ```
   (use the same `partitionKey`/`envelope` the test already builds).
3. Where it calls `runConsumer(consumer, db)`, change to `runConsumer(consumer, db, registry)`.

> The test stays self-contained: it produces Avro and consumes Avro. Keep all
> existing assertions (projection upsert, inbox dedup).

- [ ] **Step 4: Run the test (requires `pnpm infra:up`)**

Run: `pnpm jest apps/projection-worker/test/consumer.spec.ts`
Expected: PASS — projection + dedup intact over Avro.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc -p apps/projection-worker/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/projection-worker/src/main.ts apps/projection-worker/package.json apps/projection-worker/test/consumer.spec.ts pnpm-lock.yaml
git commit -m "feat(projection-worker): consume order events as Avro"
```

---

## Task 8c: Migrate saga-worker consumer to Avro

**Files:**
- Modify: `apps/saga-worker/src/main.ts`
- Modify: `apps/saga-worker/package.json` (add `@flashbite/messaging` dep)
- Modify: the saga Kafka consumer test (find it: `ls apps/saga-worker/test`)

- [ ] **Step 1: Add the workspace dep**

In `apps/saga-worker/package.json` `dependencies`, add `"@flashbite/messaging": "workspace:*",` then run `pnpm install`.

- [ ] **Step 2: Rewrite `startOrderConsumer` in `apps/saga-worker/src/main.ts`**

Change the imports: add to the kafkajs/contracts imports

```ts
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { createRegistry, readEnvelope } from "@flashbite/messaging";
```

and drop `type EventEnvelope` from the `@flashbite/contracts` import if unused (keep `EVENT_TYPES`, `ORDER_SAGA`, `TOPICS`, `OrderPlacedPayload`, `CONSUMER_GROUPS`).

Replace the `startOrderConsumer` signature + body's parse step:

```ts
export async function startOrderConsumer(
  consumer: Consumer,
  temporal: TemporalHandle,
  slaSeconds: number,
  registry: SchemaRegistry,
): Promise<SagaWorkerHandle> {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const envelope = await readEnvelope(registry, message);
      if (!envelope) return;
      if (envelope.eventType !== EVENT_TYPES.ORDER_PLACED) return;
      const p = envelope.payload as OrderPlacedPayload;
      try {
        await temporal.client.workflow.start(ORDER_SAGA.WORKFLOW_TYPE, {
          taskQueue: ORDER_SAGA.TASK_QUEUE,
          workflowId: `${envelope.tenantId}:${p.orderId}`,
          workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
          args: [{ tenantId: envelope.tenantId, orderId: p.orderId, totalAmount: p.totalAmount, slaSeconds }],
        });
      } catch (err) {
        if (!/already started|WorkflowExecutionAlreadyStarted/i.test(String(err))) throw err;
      }
    },
  });
  return { stop: async () => { await consumer.disconnect(); } };
}
```

In `main()`, create the registry and pass it:

```ts
  const registry = createRegistry(config.schemaRegistryUrl);
  const orderConsumer = await startOrderConsumer(consumer, temporal, config.sagaSlaSeconds, registry);
```

- [ ] **Step 3: Update the saga consumer test**

Run `ls apps/saga-worker/test` and open the file that exercises `startOrderConsumer` (it produces an `OrderPlaced` and asserts a workflow starts). Apply the same three edits as Task 8b Step 3:
1. Add `createRegistry`/`registerAllSchemas`/`publishEnvelope` imports + `HOST`/`registry`; register in `beforeAll`.
2. Replace the in-test `producer.send({ ... JSON.stringify ... })` with `await publishEnvelope(producer, registry, TOPICS.ORDER_EVENTS, partitionKey, envelope)`.
3. Pass `registry` as the new 4th arg to `startOrderConsumer(consumer, temporal, slaSeconds, registry)`.

> If a saga e2e drives the *full* flow via the real outbox-poller, it will be
> exercised in Task 11; here only the direct `startOrderConsumer` test must pass.

- [ ] **Step 4: Run the test (requires `pnpm infra:up` incl. Temporal)**

Run: `pnpm jest apps/saga-worker/test`
Expected: PASS — OrderPlaced (Avro) still starts the workflow.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc -p apps/saga-worker/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/saga-worker/src/main.ts apps/saga-worker/package.json apps/saga-worker/test pnpm-lock.yaml
git commit -m "feat(saga-worker): consume order events as Avro (header-based filter)"
```

---

## Task 8d: Migrate read-api SSE feeder to Avro

**Files:**
- Modify: `apps/read-api/src/sse/sse-feeder.service.ts`
- Modify: `apps/read-api/package.json` (add `@flashbite/messaging` dep if absent)
- Modify: the read-api SSE test (find it: `grep -rl "toStreamEvent\|sse-feeder\|/stream" apps/read-api/test`)

- [ ] **Step 1: Add the workspace dep (if not already present)**

Check `apps/read-api/package.json` `dependencies`; if `@flashbite/messaging` is absent, add `"@flashbite/messaging": "workspace:*",` and run `pnpm install`.

- [ ] **Step 2: Rewrite `apps/read-api/src/sse/sse-feeder.service.ts`**

```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Kafka, logLevel, type Consumer } from "kafkajs";
import { loadConfig } from "@flashbite/shared";
import {
  CONSUMER_GROUPS,
  EVENT_TYPES,
  ORDER_STATUS,
  TOPICS,
  type EventEnvelope,
  type OrderPlacedPayload,
} from "@flashbite/contracts";
import { createRegistry, readEnvelope } from "@flashbite/messaging";
import { OrderStreamService } from "./order-stream.service";

/** Maps an order-events envelope to the merchant SSE event shape. */
export function toStreamEvent(envelope: EventEnvelope) {
  const p = envelope.payload as Partial<OrderPlacedPayload> & { reason?: string };
  const cancelReason = envelope.eventType === EVENT_TYPES.ORDER_CANCELLED ? p.reason : undefined;
  return { orderId: p.orderId ?? "", eventType: envelope.eventType, status: ORDER_STATUS.PLACED, cancelReason };
}

@Injectable()
export class SseFeederService implements OnModuleInit, OnModuleDestroy {
  private consumer!: Consumer;
  constructor(private readonly stream: OrderStreamService) {}

  async onModuleInit(): Promise<void> {
    const config = loadConfig();
    const registry = createRegistry(config.schemaRegistryUrl);
    const kafka = new Kafka({ clientId: CONSUMER_GROUPS.READ_API_SSE, brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
    this.consumer = kafka.consumer({ groupId: `${CONSUMER_GROUPS.READ_API_SSE}-${process.pid}` });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const envelope = await readEnvelope(registry, message);
        if (!envelope) return;
        this.stream.publish(envelope.tenantId, toStreamEvent(envelope));
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
```

- [ ] **Step 3: Update the read-api SSE e2e test**

Find the SSE test (`grep -rl "/merchant/orders/stream\|sse" apps/read-api/test`). It produces `order-events` to drive the stream. Apply:
1. Register schemas in `beforeAll` (`createRegistry`/`registerAllSchemas`, `HOST`).
2. Replace its in-test `producer.send({ ... JSON.stringify(envelope) ... })` with `await publishEnvelope(producer, registry, TOPICS.ORDER_EVENTS, partitionKey, envelope)`.
3. Keep all SSE assertions.

> `toStreamEvent` is unchanged, so its unit assertions (if any) still hold.

- [ ] **Step 4: Run the test (requires `pnpm infra:up`)**

Run: `pnpm jest apps/read-api/test` (or the specific SSE spec path)
Expected: PASS — SSE events flow from Avro order events.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc -p apps/read-api/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/read-api/src/sse/sse-feeder.service.ts apps/read-api/package.json apps/read-api/test pnpm-lock.yaml
git commit -m "feat(read-api): SSE feeder consumes order events as Avro"
```

---

## Task 9: Migrate `telemetry-streams` (producer + worker) to Avro

**Files:**
- Modify: `apps/read-api/src/drivers/telemetry-producer.service.ts`
- Modify: `apps/telemetry-worker/src/main.ts`
- Modify: `apps/telemetry-worker/package.json` (add `@flashbite/messaging` dep)
- Modify: the telemetry consumer test (find it: `ls apps/telemetry-worker/test`)

- [ ] **Step 1: Add the workspace dep to telemetry-worker**

In `apps/telemetry-worker/package.json` `dependencies`, add `"@flashbite/messaging": "workspace:*",` then run `pnpm install`. (read-api already gained the dep in Task 8d.)

- [ ] **Step 2: Rewrite `apps/read-api/src/drivers/telemetry-producer.service.ts`**

```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Kafka, logLevel, type Producer } from "kafkajs";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { buildEnvelope, loadConfig } from "@flashbite/shared";
import { EVENT_TYPES, TOPICS, type DriverTelemetryPayload } from "@flashbite/contracts";
import { createRegistry, publishEnvelope } from "@flashbite/messaging";

@Injectable()
export class TelemetryProducerService implements OnModuleInit, OnModuleDestroy {
  private producer!: Producer;
  private registry!: SchemaRegistry;

  async onModuleInit(): Promise<void> {
    const config = loadConfig();
    const kafka = new Kafka({ clientId: "read-api-telemetry", brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
    this.producer = kafka.producer();
    await this.producer.connect();
    this.registry = createRegistry(config.schemaRegistryUrl);
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer?.disconnect();
  }

  async publish(tenantId: string, payload: DriverTelemetryPayload): Promise<void> {
    // Normalize the optional orderId to explicit null for the Avro ["null","string"] union.
    const envelope = buildEnvelope({
      tenantId,
      eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED,
      version: 1,
      payload: { ...payload, orderId: payload.orderId ?? null } as DriverTelemetryPayload,
    });
    await publishEnvelope(this.producer, this.registry, TOPICS.TELEMETRY_STREAMS, `${tenantId}:${payload.driverId}`, envelope);
  }
}
```

- [ ] **Step 3: Rewrite the telemetry consumer in `apps/telemetry-worker/src/main.ts`**

Change the imports block to:

```ts
import { Kafka, logLevel, type Consumer } from "kafkajs";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import type { Cluster } from "ioredis";
import { createRedisCluster, loadConfig } from "@flashbite/shared";
import { CONSUMER_GROUPS, TOPICS } from "@flashbite/contracts";
import { createRegistry, readEnvelope } from "@flashbite/messaging";
import { applyTelemetry } from "./telemetry";
```

Replace `runTelemetryConsumer`:

```ts
/** Wires a kafkajs consumer to applyTelemetry (Avro decode + header metadata). */
export async function runTelemetryConsumer(consumer: Consumer, cluster: Cluster, registry: SchemaRegistry): Promise<TelemetryConsumerHandle> {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.TELEMETRY_STREAMS, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const envelope = await readEnvelope(registry, message);
      if (!envelope) return;
      await applyTelemetry(cluster, envelope);
    },
  });
  return { stop: async () => { await consumer.disconnect(); } };
}
```

In `main()`, create the registry and pass it:

```ts
  const registry = createRegistry(config.schemaRegistryUrl);
  const handle = await runTelemetryConsumer(consumer, cluster, registry);
```

- [ ] **Step 4: Update the telemetry consumer test**

Run `ls apps/telemetry-worker/test` and open the consumer test. Apply:
1. Register schemas in `beforeAll` (`createRegistry`/`registerAllSchemas`, `HOST`, `registry`).
2. Replace its in-test `producer.send({ ... JSON.stringify(envelope) ... })` (a `DriverTelemetryStreamed` envelope) with `await publishEnvelope(producer, registry, TOPICS.TELEMETRY_STREAMS, key, envelope)`. Ensure the test envelope's payload sets `orderId: null` (or omit and let the producer path normalize — for the direct test, set `orderId: null`).
3. Pass `registry` as the new 3rd arg to `runTelemetryConsumer(consumer, cluster, registry)`.
4. Keep the Redis GEOADD assertions.

- [ ] **Step 5: Run the test (requires `pnpm infra:up`)**

Run: `pnpm jest apps/telemetry-worker/test`
Expected: PASS — Avro telemetry → Redis GEOADD.

- [ ] **Step 6: Typecheck both apps**

Run: `pnpm exec tsc -p apps/telemetry-worker/tsconfig.json --noEmit && pnpm exec tsc -p apps/read-api/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/read-api/src/drivers/telemetry-producer.service.ts apps/telemetry-worker/src/main.ts apps/telemetry-worker/package.json apps/telemetry-worker/test pnpm-lock.yaml
git commit -m "feat(telemetry): produce + consume telemetry as Avro"
```

---

## Task 10: Dev bring-up + CI schema registration

**Files:**
- Modify: `package.json` (root — dev orchestration that runs `register:schemas`)
- Modify: the CI workflow (find it: `ls .github/workflows`)

- [ ] **Step 1: Inspect current dev/CI wiring**

Run: `ls .github/workflows && grep -rn "infra:up\|topic\|redpanda\|jest" .github/workflows`
Identify where infra comes up and where `pnpm jest` runs.

- [ ] **Step 2: Add schema registration to CI before the test step**

In the CI workflow, after the step that brings up infra / creates topics and before the `pnpm jest` step, add a step:

```yaml
      - name: Register Avro schemas
        run: pnpm register:schemas
        env:
          SCHEMA_REGISTRY_URL: http://localhost:18081
```

> If CI waits on Redpanda readiness, ensure the registry port (18081) is reachable
> before this step — add a short readiness wait (`curl -sf http://localhost:18081/subjects`)
> if the existing infra-wait doesn't already cover it.

- [ ] **Step 3: Add a convenience dev script**

In root `package.json` `scripts`, add (after `infra:up`):

```json
"infra:schemas": "pnpm register:schemas",
```

> Document in the README (Task 11) that local dev runs `pnpm infra:up` then
> `pnpm register:schemas` once before producing.

- [ ] **Step 4: Verify the CI workflow file parses**

Run: `pnpm dlx yaml-lint .github/workflows/*.yml 2>/dev/null || node -e "require('js-yaml')" 2>/dev/null || echo "skip lint"`
(If no YAML linter is available, visually confirm indentation matches sibling steps.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows package.json
git commit -m "ci: register Avro schemas before integration tests"
```

---

## Task 11: Docs + full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Update `README.md`**

In the dev quick-start, add `pnpm register:schemas` as a one-time step after `pnpm infra:up` (before starting producers). In any "event bus / Kafka" description, note messages are **Confluent-Avro** (payload value + metadata headers) governed by the Schema Registry at `localhost:18081`, registered via `pnpm register:schemas`.

- [ ] **Step 2: Update `docs/ARCHITECTURE.md`**

- In §1 overview and the §3 "Why it's hard mode" list, state that Kafka carries **Avro** payloads with metadata in headers, schemas governed by a registry (explicit registration, BACKWARD compatibility, producers lookup-only).
- In §9 "Not yet built", **remove** the "Avro + Schema Registry" bullet and add a "**Completed in Phase 3b**" note mirroring the 3a note's style.
- If a new Mermaid block is added, validate per the project's offline Mermaid check and avoid bare `+`, second `:` in sequence messages, and `->` inside flowchart labels (GitHub's renderer rejects these).

- [ ] **Step 3: Full backend verification (requires `pnpm infra:up` + schemas registered)**

```bash
pnpm infra:up
pnpm register:schemas
pnpm jest
```
Expected: all suites green — messaging unit + e2e (registration, compatibility), outbox-poller, projection, saga, telemetry, read-api SSE, plus the unchanged RLS/auth/operator suites.

- [ ] **Step 4: Repo-wide typecheck**

```bash
pnpm -r exec tsc --noEmit 2>/dev/null || for d in packages/* apps/*; do [ -f "$d/tsconfig.json" ] && pnpm exec tsc -p "$d/tsconfig.json" --noEmit; done
```
Expected: PASS across packages/apps.

- [ ] **Step 5: Confirm nothing on the bus is JSON anymore**

Run: `grep -rn "JSON.stringify\|JSON.parse" apps/outbox-poller/src apps/projection-worker/src apps/saga-worker/src apps/telemetry-worker/src apps/read-api/src/sse apps/read-api/src/drivers/telemetry-producer.service.ts`
Expected: no Kafka value (de)serialization via JSON remains (matches at produce/consume boundaries are removed).

- [ ] **Step 6: Commit**

```bash
git add README.md docs/ARCHITECTURE.md
git commit -m "docs(phase-3b): Avro + Schema Registry on the event bus"
```

---

## Self-review notes (coverage map)

- Spec "wire format" → Tasks 2 (headers), 4 (serde), 7 (publish/consume), 8–9 (sites).
- Spec "Avro schemas in contracts" → Task 3.
- Spec "new @flashbite/messaging package" → Tasks 1–7.
- Spec "explicit registration, producers lookup-only" → Task 4 (lookup-only by construction), Task 5 (register script).
- Spec "BACKWARD compatibility + rejection test" → Tasks 5 + 6.
- Spec "2 produce + 4 consume sites" → Tasks 8 (poller), 8b (projection), 8c (saga), 8d (sse-feeder), 9 (telemetry producer + worker).
- Spec "config + .env" → Task 1.
- Spec "CI + dev workflow" → Task 10.
- Spec "tests updated" → Tasks 8/8b/8c/8d/9 (e2e), 2/3/4/7 (unit).
- Spec "docs" → Task 11.
- Spec "event store/outbox/aggregate unchanged" → no task touches them (verified by Task 11 Step 3 full suite).
