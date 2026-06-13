# Phase 1a — Verification

Prereq: `pnpm infra:up`.

## Automated
`pnpm test` — contracts, shared, tenant-context, write-api (health + orders), outbox-poller. 12 tests.

## Manual end-to-end (command plane)
1. `pnpm dev:write-api`  (port 3001)
2. `pnpm dev:outbox`
3. POST an order to `/orders` with header `X-Tenant-ID: berlin`.
4. Confirm: one `event_store` row, one `outbox` row that flips PENDING -> SENT,
   and the JSON envelope appears on the `order-events` topic.
5. Re-POST the same `orderId` -> still one event, one outbox row (idempotent).

Runtime: apps run via `@swc-node/register` (emits decorator metadata for idiomatic NestJS DI); `--env-file=.env` injects config.
`tsconfig-paths/register` resolves `@flashbite/*` path aliases at runtime; KAFKA_BROKERS defaults to localhost:9092.
NestJS DI uses idiomatic `constructor(private readonly x: X) {}` — no explicit `@Inject()` needed.
Phase 1b consumes these `order-events` into Mongo read models.
