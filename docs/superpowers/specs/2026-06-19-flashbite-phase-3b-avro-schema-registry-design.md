# Phase 3b — Avro + Schema Registry (design)

**Status:** approved (brainstorm) — ready for implementation plan
**Date:** 2026-06-19
**Builds on:** Phase 3a (event-sourced Order aggregate). Companion to the Phase 3
decomposition; this is slice **3b** of Phase 3.

## Goal

Replace the JSON Kafka envelopes with **Avro** payloads serialized through a
**Schema Registry** (Redpanda's built-in registry, already running at
`localhost:18081`). Schemas become governed artifacts: registered explicitly,
compatibility-checked, and looked up (never auto-created) by producers. The
Postgres event store, outbox table, Order aggregate, and the projection /
telemetry handler logic are **unchanged** — this slice swaps only the Kafka wire
format and adds schema governance.

## Decisions (locked during brainstorm)

1. **Schema model = headers + payload-only value (option B).** The Avro value is
   *only* the event payload. Envelope metadata moves to Kafka message **headers**.
2. **Subject strategy = TopicRecordNameStrategy.** One subject per event type:
   `<topic>-<record-fqn>`. `order-events` legitimately carries 3 schemas.
3. **Registration = explicit; producers are lookup-only (option A).** A
   `register-schemas` script registers hand-written `.avsc` files; producers
   resolve schema ids and **never register** (enforced by construction — they
   call `encode(id, payload)`, never `register()`).
4. **Compatibility = BACKWARD, enforced, with a rejection test (option A).** No
   contrived v2 field ships; we *prove* breaking changes are blocked.
5. **Hard cut** to Avro — no dual JSON/Avro read period (ephemeral dev-container
   topics, no production data).
6. **Serde library = `@kafkajs/confluent-schema-registry`** (Confluent wire
   format, `avsc` under the hood).
7. **The Avro/serde code lives in a new `@flashbite/messaging` package.** The
   `.avsc` files and the subject map live in `@flashbite/contracts`.

## Current state (what 3b changes)

- **Envelope shape** `EventEnvelope<T> = { tenantId, eventId, eventType, version,
  occurredAt, payload }` — defined in `@flashbite/contracts`, built by
  `buildEnvelope` in `packages/shared/src/envelope.ts`.
- **2 produce sites** (both `JSON.stringify(envelope)` today):
  - `apps/outbox-poller/src/poller.ts` → `row.topic` (mainly `order-events`),
    key `row.partitionKey`.
  - `apps/read-api/src/drivers/telemetry-producer.service.ts` →
    `telemetry-streams`, key `${tenantId}:${driverId}`.
- **4 consume sites** (all `JSON.parse(value) as EventEnvelope` today):
  - `apps/projection-worker/src/main.ts` (group `projection-worker`,
    `order-events`) → `applyEvent(db, envelope)`.
  - `apps/saga-worker/src/main.ts` (group `saga-worker`, `order-events`) — filters
    `envelope.eventType === OrderPlaced`, starts a Temporal workflow.
  - `apps/telemetry-worker/src/main.ts` (group `telemetry-worker`,
    `telemetry-streams`) → `applyTelemetry(cluster, envelope)`.
  - `apps/read-api/src/sse/sse-feeder.service.ts` (group `read-api-sse`,
    `order-events`) → maps envelope to the merchant SSE event.
- **4 event types:** `OrderPlaced`, `OrderAccepted`, `OrderCancelled`
  (`order-events`), `DriverTelemetryStreamed` (`telemetry-streams`).
- **Infra ready:** Redpanda Schema Registry exposed at `localhost:18081`
  (internal `8081`); `redpanda-console` already wired to it. No new infra.

## Wire format

Per message:

- **value** = Confluent wire format: `0x00` magic byte + 4-byte big-endian schema
  id + Avro binary of the **payload only**.
- **headers** (all string-encoded):
  - `eventType` — e.g. `OrderPlaced` (the routing key consumers read first).
  - `tenantId`, `eventId`, `occurredAt` — strings.
  - `version` — the aggregate/event version as a decimal string.
- **key** = unchanged (`tenantId:orderId` for order events,
  `tenantId:driverId` for telemetry).

Decode path: `@kafkajs/confluent-schema-registry`'s `decode(buffer)` reads the
schema id from the wire bytes and fetches the schema from the registry
automatically — the consumer does not need the subject. The consumer reassembles
the existing `EventEnvelope` from `parseHeaders(headers)` + the decoded payload,
so all four downstream handlers keep their current signatures.

## Avro schemas (`@flashbite/contracts`)

Namespace `com.flashbite.events`. Hand-written `.avsc`, one record per event type,
mirroring the existing payload TypeScript types exactly.

- `packages/contracts/avro/order-placed.avsc` — record `OrderPlaced`
  `{ orderId: string, customerId: string, items: array<record OrderItem {
  sku: string, qty: int, price: double }>, totalAmount: double }`.
- `packages/contracts/avro/order-accepted.avsc` — record `OrderAccepted`
  `{ orderId: string }`.
- `packages/contracts/avro/order-cancelled.avsc` — record `OrderCancelled`
  `{ orderId: string, reason: string }`.
- `packages/contracts/avro/driver-telemetry.avsc` — record `DriverTelemetry`
  `{ driverId: string, orderId: ["null", "string"] = null, lng: double,
  lat: double }`.

> The exact field types must be verified against the live payload interfaces in
> `packages/contracts/src/index.ts` during planning (especially `items` element
> shape and numeric types) so the Avro records match 1:1.

`packages/contracts/src/index.ts` gains a pure subject map (no runtime deps):

```ts
export const AVRO_NAMESPACE = "com.flashbite.events";

// One entry per event type. Subject = `${topic}-${namespace}.${recordName}`
// (TopicRecordNameStrategy).
export const SUBJECTS = [
  { eventType: EVENT_TYPES.ORDER_PLACED,    topic: TOPICS.ORDER_EVENTS,      recordName: "OrderPlaced",     avsc: "order-placed.avsc" },
  { eventType: EVENT_TYPES.ORDER_ACCEPTED,  topic: TOPICS.ORDER_EVENTS,      recordName: "OrderAccepted",   avsc: "order-accepted.avsc" },
  { eventType: EVENT_TYPES.ORDER_CANCELLED, topic: TOPICS.ORDER_EVENTS,      recordName: "OrderCancelled",  avsc: "order-cancelled.avsc" },
  { eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED, topic: TOPICS.TELEMETRY_STREAMS, recordName: "DriverTelemetry", avsc: "driver-telemetry.avsc" },
] as const;

export function subjectFor(topic: string, recordName: string): string {
  return `${topic}-${AVRO_NAMESPACE}.${recordName}`;
}
```

## New package: `@flashbite/messaging`

Mirrors the existing package layout (`package.json`, `tsconfig.json`, jest config,
`src/index.ts`). Runtime deps: `@kafkajs/confluent-schema-registry`; peer/dev:
`kafkajs` (for `Producer`/`IHeaders` types), `@flashbite/contracts`. **Does not
depend on `@flashbite/shared`** (no cycle; producers import both).

Files:

- `src/registry.ts`
  ```ts
  import { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
  export function createRegistry(url: string): SchemaRegistry {
    return new SchemaRegistry({ host: url });
  }
  ```
- `src/headers.ts` — metadata ↔ Kafka headers.
  ```ts
  import type { EventEnvelope } from "@flashbite/contracts";
  export type EnvelopeMeta = Omit<EventEnvelope, "payload">;
  export function buildHeaders(meta: EnvelopeMeta): Record<string, string> {
    return {
      eventType: meta.eventType,
      tenantId: meta.tenantId,
      eventId: meta.eventId,
      version: String(meta.version),
      occurredAt: meta.occurredAt,
    };
  }
  export function parseHeaders(headers: import("kafkajs").IHeaders | undefined): EnvelopeMeta {
    const h = headers ?? {};
    const s = (k: string) => (h[k] == null ? "" : h[k]!.toString());
    return {
      eventType: s("eventType"),
      tenantId: s("tenantId"),
      eventId: s("eventId"),
      version: Number(s("version")),
      occurredAt: s("occurredAt"),
    };
  }
  ```
- `src/serde.ts` — encode/decode + cached id resolution. **Lookup-only**: resolves
  the latest registered id for a subject and caches it; throws loudly if the
  subject is not registered (never registers).
  ```ts
  import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
  const idCache = new Map<string, number>();
  export async function resolveSchemaId(registry: SchemaRegistry, subject: string): Promise<number> {
    const hit = idCache.get(subject);
    if (hit != null) return hit;
    const id = await registry.getLatestSchemaId(subject); // throws if not registered
    idCache.set(subject, id);
    return id;
  }
  export async function encodePayload(registry: SchemaRegistry, subject: string, payload: unknown): Promise<Buffer> {
    return registry.encode(await resolveSchemaId(registry, subject), payload);
  }
  export async function decodePayload<T = unknown>(registry: SchemaRegistry, value: Buffer): Promise<T> {
    return registry.decode(value) as Promise<T>;
  }
  export function __resetIdCache(): void { idCache.clear(); } // test seam
  ```
- `src/publish.ts` — the single produce code path shared by both producers.
  ```ts
  import type { Producer } from "kafkajs";
  import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
  import type { EventEnvelope } from "@flashbite/contracts";
  import { subjectFor, SUBJECTS } from "@flashbite/contracts";
  import { encodePayload } from "./serde";
  import { buildHeaders } from "./headers";
  export async function publishEnvelope(
    producer: Producer, registry: SchemaRegistry, topic: string, key: string, envelope: EventEnvelope,
  ): Promise<void> {
    const entry = SUBJECTS.find((s) => s.eventType === envelope.eventType);
    if (!entry) throw new Error(`No Avro subject registered for eventType ${envelope.eventType}`);
    const value = await encodePayload(registry, subjectFor(topic, entry.recordName), envelope.payload);
    await producer.send({ topic, messages: [{ key, value, headers: buildHeaders(envelope) }] });
  }
  ```
- `src/consume.ts` — the symmetric consume helper.
  ```ts
  import type { KafkaMessage } from "kafkajs";
  import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
  import type { EventEnvelope } from "@flashbite/contracts";
  import { decodePayload } from "./serde";
  import { parseHeaders } from "./headers";
  export async function readEnvelope(registry: SchemaRegistry, message: KafkaMessage): Promise<EventEnvelope | null> {
    if (!message.value) return null;
    const payload = await decodePayload(registry, message.value);
    return { ...parseHeaders(message.headers), payload };
  }
  ```
- `src/register.ts` + bin — the registration script (below).
- `src/index.ts` — re-exports the above.

## Registration script (`pnpm register:schemas`)

`packages/messaging/src/register.ts`, runnable via a root script
`pnpm register:schemas` (e.g. `tsx packages/messaging/src/register.ts`).

For each `SUBJECTS` entry:

1. Load the `.avsc` JSON from `@flashbite/contracts/avro/<file>`.
2. Compute the subject via `subjectFor(topic, recordName)`.
3. Set the subject's compatibility level to **BACKWARD**. The serde library does
   **not** expose subject-compatibility config, so this is a direct REST call to
   the registry: `PUT {url}/config/{subject}` with body
   `{"compatibility":"BACKWARD"}`.
4. Register the schema with the lib:
   `registry.register({ type: SchemaType.AVRO, schema: JSON.stringify(avsc) }, { subject })`.
   The registry rejects (HTTP 409) a schema that is not BACKWARD-compatible with
   the latest registered version; `register` throws, and the script surfaces that
   as a non-zero exit (fails CI).

Reads the registry URL from `SCHEMA_REGISTRY_URL` (default `http://localhost:18081`).
Idempotent: re-registering an identical schema is a no-op (returns the existing id).

## Config (`packages/shared/src/config.ts`)

Add `schemaRegistryUrl: env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081"` to
`AppConfig` / `loadConfig`. Add `SCHEMA_REGISTRY_URL` to `.env.example`.

## Produce/consume site changes

Each producer constructs a registry once (`createRegistry(config.schemaRegistryUrl)`)
alongside its Kafka producer and swaps its `producer.send({ value: JSON.stringify(...) })`
for `publishEnvelope(producer, registry, topic, key, envelope)`:

- `apps/outbox-poller/src/poller.ts` — `pollOnce` takes the registry; for each
  row, `publishEnvelope(producer, registry, row.topic, row.partitionKey, row.payload as EventEnvelope)`.
  The outbox row format in Postgres is unchanged (it still stores the full
  envelope JSON). `main.ts` builds the registry and passes it in.
- `apps/read-api/src/drivers/telemetry-producer.service.ts` — build the envelope as
  today, then `publishEnvelope(...)` instead of `JSON.stringify`. The registry is a
  module-provided singleton (NestJS provider).

Each consumer swaps `JSON.parse(message.value.toString())` for
`readEnvelope(registry, message)` and keeps its existing handler:

- `projection-worker`, `saga-worker`, `telemetry-worker`, `read-api/sse/sse-feeder.service.ts`.
- The saga still filters on `envelope.eventType` (now sourced from the header via
  `readEnvelope`).

## Error handling

- **Producer (lookup-only):** unknown/unregistered subject → `resolveSchemaId`
  throws → the outbox row stays `PENDING` and is retried on the next poll
  (preserves at-least-once). The telemetry producer surfaces the error to the
  caller (the ingest endpoint already returns `202` fire-and-forget; a registry
  outage there fails the publish and is logged).
- **Consumer:** decode failure (unknown schema id / corrupt value) → the error
  propagates out of `eachMessage`. With governed schemas a decode failure is a
  real defect, and topics are ephemeral, so we fail loudly rather than silently
  drop. A poison-message **DLQ is backlog**, not in scope.

## Testing

- **`@flashbite/messaging` unit tests:**
  - `headers.spec.ts` — round-trip `buildHeaders`/`parseHeaders` (incl. numeric
    `version` coercion, missing-header defaults).
  - `serde.spec.ts` — id-cache behaviour and that `encodePayload`/`decodePayload`
    round-trip through a stubbed registry; `resolveSchemaId` throws on an
    unregistered subject.
- **Compatibility-rejection test** (against the live registry, in `messaging` or a
  dedicated e2e): set a throwaway subject to BACKWARD, register a baseline schema,
  then
  - a BACKWARD-**incompatible** change — **add a required field with no default**
    (under BACKWARD the new reader can't read old data lacking it) — is **rejected**
    (409 / throws);
  - a **compatible** change — add an optional field with a default (and removing a
    field is also BACKWARD-compatible) — is **accepted**.
- **Updated Kafka e2e** (boot against live infra; each registers schemas in
  `beforeAll` via the registration routine):
  - `apps/outbox-poller/test/poller.spec.ts` — assert Avro value + headers instead
    of JSON; full round-trip via `readEnvelope`.
  - `apps/projection-worker/test/consumer.spec.ts` — produce Avro, consume,
    project; inbox dedup intact.
  - telemetry consumer test — Avro round-trip → Redis GEOADD.
  - saga consumer test — header-based `OrderPlaced` filter still starts the
    workflow.
  - read-api sse-feeder test — Avro decode → SSE event shape.
- **`packages/shared/src/envelope.spec.ts`** — unchanged (envelope builder stays);
  no longer the wire format, but still the in-memory shape.

## CI

In the workflow that runs integration tests against infra (already boots
Postgres/Mongo/Redis/Redpanda/Temporal): after infra is up and topics are created,
run `pnpm register:schemas` before the test step. Include the
compatibility-rejection test in the suite.

## Dev workflow

`pnpm register:schemas` becomes part of the dev bring-up (after `infra:up` /
topic creation) — documented in the README and wired into the existing
dev/orchestration script so a fresh clone gets registered schemas before
producing.

## File structure summary

**New:**
- `packages/messaging/` — `package.json`, `tsconfig.json`, jest config,
  `src/{index,registry,headers,serde,publish,consume,register}.ts`,
  `src/{headers,serde}.spec.ts`.
- `packages/contracts/avro/{order-placed,order-accepted,order-cancelled,driver-telemetry}.avsc`.

**Modified:**
- `packages/contracts/src/index.ts` — `AVRO_NAMESPACE`, `SUBJECTS`, `subjectFor`.
- `packages/shared/src/config.ts` — `schemaRegistryUrl`.
- `apps/outbox-poller/src/{poller,main}.ts`.
- `apps/read-api/src/drivers/telemetry-producer.service.ts` (+ its module).
- `apps/projection-worker/src/main.ts`.
- `apps/saga-worker/src/main.ts`.
- `apps/telemetry-worker/src/main.ts`.
- `apps/read-api/src/sse/sse-feeder.service.ts`.
- The 5 Kafka e2e tests listed above.
- `package.json` (root) — `register:schemas` script + dev wiring; workspace dep on
  `@flashbite/messaging` where consumed.
- `.env.example` — `SCHEMA_REGISTRY_URL`.
- CI workflow — schema registration step.
- `README.md` / `docs/ARCHITECTURE.md` — Avro + registry (after implementation).

## Out of scope / backlog

- Dual JSON↔Avro read period (hard cut instead).
- Poison-message DLQ / dead-letter handling.
- A shipped v2 schema evolution (we only *prove* evolution is governed).
- Protobuf / JSON-Schema serde.
- Schema-registry auth / TLS (local dev registry is open).

## Success criteria

1. All Kafka messages on both topics are Confluent-Avro encoded (payload-only
   value) with envelope metadata in headers; nothing on the bus is JSON anymore.
2. Producers fail loudly if a schema isn't registered; they never auto-register.
3. `pnpm register:schemas` registers all 4 subjects at BACKWARD compatibility and
   fails on a breaking change.
4. A test proves a BACKWARD-incompatible schema is rejected and a compatible one
   is accepted.
5. The full order lifecycle (place → project → saga accept/cancel → SSE) and the
   telemetry plane (ingest → GEOADD → nearby) work end-to-end over Avro, with all
   existing e2e suites green.
6. Event store, outbox table, aggregate, and projection/telemetry handler logic
   are unchanged (only the wire boundary moved).
