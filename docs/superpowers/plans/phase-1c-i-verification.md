# Phase 1c-i — Verification

Prereq: `pnpm infra:up` (Postgres, Redpanda, MongoDB, Redis Cluster, Temporal).

## Automated
`pnpm test` — adds shared appendEvent/connectTemporal, projection accepted/cancelled,
saga activities + workflow (time-skipping) + live e2e (accept) + breach e2e, write-api accept endpoint.

## Manual end-to-end
1. Start: dev:write-api, dev:outbox, dev:projection, dev:read-api, dev:saga.
2. POST an order -> saga-worker starts the workflow on OrderPlaced.
3. POST /orders/<id>/accept -> workflow ACCEPTED -> OrderAccepted event -> read model status ACCEPTED.
4. Or do nothing: after the SLA the workflow refunds + emits OrderCancelled -> read model CANCELLED.

Saga: charge -> race SLA vs merchant-approval signal -> accept | refund+cancel; events
flow back through the outbox -> order-events -> projection.
Phase 1c-ii adds driver telemetry (GPS -> Redis geo).
