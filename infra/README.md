# FlashBite Local Infrastructure

One command brings up the full stack:

```bash
pnpm infra:up      # start everything (detached)
pnpm infra:ps      # show service status
pnpm infra:down    # stop (keep volumes)
pnpm infra:nuke    # stop and delete all volumes (clean slate)
```

## Services & ports

| Service           | Host port(s)          | Purpose                                   |
|-------------------|-----------------------|-------------------------------------------|
| postgres          | 5434                  | App event store + outbox                  |
| mongodb           | 27017                 | Read models                               |
| redpanda          | 9092, 18081, 9644     | Kafka API, Schema Registry, Admin         |
| redpanda-console  | 8085                  | Kafka/topic observability UI              |
| temporal          | 7233                  | Workflow server (own Postgres)            |
| temporal-ui       | 8080                  | Temporal Web UI                           |
| redis-cluster     | 7100-7105 (+17100-)   | 6-node Redis Cluster (grokzen, 1 container)|

## Notes

- **Redis runs as a single-container grokzen 6-node cluster** (`grokzen/redis-cluster`).
  On Docker Desktop for macOS, discrete-container Redis Cluster nodes cannot be reached
  from the host: `network_mode: host` binds inside the Linux VM only, and bridge mode
  breaks inter-node gossip when nodes announce `127.0.0.1`. grokzen runs all 6 redis
  processes in one network namespace and publishes every node port, so a host client can
  follow MOVED redirects. Logically it is still a 6-node cluster (3 masters + 3 replicas);
  production would use 6 discrete nodes / a StatefulSet.
- **Ports start at 7100** to avoid the macOS AirPlay Receiver, which occupies port 7000.
- **Temporal uses the `postgres12` schema plugin** (`DB=postgres12`) and its own Postgres
  instance, kept separate from the application database.
- **Topics** `order-events` (6 partitions) and `telemetry-streams` (12 partitions) are
  created by the `redpanda-init` one-shot service.

## Spikes

The `spikes/` package holds throwaway verification scripts (Phase 0 only). Run them after
`pnpm infra:up`:

```bash
pnpm --filter @flashbite/spikes kafka            # partition-key ordering
pnpm --filter @flashbite/spikes temporal:worker  # (terminal 1) leave running
pnpm --filter @flashbite/spikes temporal:run     # (terminal 2)
pnpm --filter @flashbite/spikes outbox           # outbox round-trip
pnpm --filter @flashbite/spikes redis            # cluster + hash tags
```

These are deleted at the start of Phase 1.

## Phase 0 exit checklist

The gate to Phase 1. All items must pass:

```
[ ] pnpm infra:up brings all services up; init one-shots exit 0
[ ] docker compose ps shows postgres/mongodb/redpanda/temporal healthy
[ ] redis-cli -c -h 127.0.0.1 -p 7100 cluster info => cluster_state:ok
[ ] rpk topic list shows order-events (6) and telemetry-streams (12)
[ ] Spike A (kafka)    => SPIKE OK
[ ] Spike B (temporal) => SPIKE OK
[ ] Spike C (outbox)   => SPIKE OK
[ ] Spike D (redis)    => SPIKE OK
[ ] http://localhost:8080 (Temporal UI) and http://localhost:8085 (Console) load
```
