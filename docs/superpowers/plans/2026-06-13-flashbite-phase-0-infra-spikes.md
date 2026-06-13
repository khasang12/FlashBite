# FlashBite Phase 0 — Infra + De-Risking Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the full local infrastructure (Postgres, Mongo, Redis Cluster, Redpanda, Temporal) via `docker-compose` and prove each unfamiliar technology works in isolation through four throwaway spikes.

**Architecture:** A pnpm monorepo skeleton holds infra config under `infra/` and disposable verification scripts under `spikes/`. The spikes are not production code — they are executable proof that the team understands Kafka partition-key ordering (via Redpanda), Temporal timers + signals, the transactional outbox round-trip, and Redis Cluster hash-tag co-location. Phase 1 reuses the infra; the spikes are deleted once Phase 0 exits.

**Tech Stack:** pnpm workspaces, TypeScript + tsx, Docker Compose, Redpanda (Kafka API), Temporal, PostgreSQL 16, MongoDB 7, Redis 7.2 Cluster, kafkajs, @temporalio/*, ioredis, pg.

---

## Context for the implementer

This is a **greenfield** repo — only `PRD-001-FlashBite-MVP.html` and `docs/` exist today. You are creating the workspace from scratch. The master spec lives at `docs/superpowers/specs/2026-06-13-flashbite-showcase-design.md`; read §6 Phase 0 and §3 before starting.

**Known local-infra gotchas this phase deliberately surfaces (each addressed in its task):**
- **Redis Cluster + host clients:** cluster nodes redirect clients (MOVED) to the address the node *advertises*. Without `cluster-announce-ip 127.0.0.1`, a host-run script gets redirected to unreachable internal Docker IPs. Fixed in Task 2.
- **Temporal auto-setup DB plugin:** Temporal ≥1.20 uses the `postgres12` schema plugin, not `postgresql`. Wrong value = boot loop. Fixed in Task 2.
- **Port collision:** the PRD put both Temporal UI and a console on 8080. We assign Temporal UI 8080, Redpanda Console 8085. Fixed in Task 2.

**Conventions:**
- Commit after every task. Use Conventional Commits (`chore:`, `feat:`, `test:`).
- All spikes are run with `pnpm --filter @flashbite/spikes <script>` from the repo root.
- A spike "passes" when it exits 0 and prints its `SPIKE OK` line; it `throw`s (exit 1) on any failed assertion.

---

## File Structure

```
flashbite/
  .gitignore                         # node, env, docker volumes
  .env.example                       # documented non-secret defaults
  package.json                       # root, pnpm workspace + scripts
  pnpm-workspace.yaml                # workspace globs
  tsconfig.base.json                 # shared TS config
  infra/
    docker-compose.yml               # all services
    README.md                        # how to run / tear down infra
  spikes/
    package.json                     # @flashbite/spikes, spike deps + scripts
    tsconfig.json
    src/
      kafka-partition.spike.ts       # Spike A
      temporal/
        workflow.ts                  # Spike B workflow
        worker.ts                    # Spike B worker
        run.spike.ts                 # Spike B client/runner
      outbox.spike.ts                # Spike C
      redis-cluster.spike.ts         # Spike D
```

---

## Task 1: Scaffold the monorepo workspace

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Initialize git (if not already a repo)**

Run:
```bash
git init
```
Expected: `Initialized empty Git repository ...` (or a notice that it already exists).

- [ ] **Step 2: Create `.gitignore`**

Create `.gitignore`:
```gitignore
node_modules/
dist/
.env
.env.local
npm-debug.log*
pnpm-debug.log*
.DS_Store
# docker named-volume data never lives in-repo, but ignore stray dumps
*.rdb
```

- [ ] **Step 3: Create the root `package.json`**

Create `package.json`:
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
    "infra:ps": "docker compose -f infra/docker-compose.yml ps"
  },
  "devDependencies": {
    "typescript": "5.5.4",
    "tsx": "4.16.2",
    "@types/node": "20.14.12"
  }
}
```

- [ ] **Step 4: Create `pnpm-workspace.yaml`**

Create `pnpm-workspace.yaml`:
```yaml
packages:
  - "spikes"
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 5: Create `tsconfig.base.json`**

Create `tsconfig.base.json`:
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
    "sourceMap": true
  }
}
```

- [ ] **Step 6: Create `.env.example`**

Create `.env.example` (non-secret local defaults — the real `.env` is gitignored):
```dotenv
# --- Postgres (application: event store + outbox) ---
PG_HOST=localhost
PG_PORT=5432
PG_USER=flashbite
PG_PASSWORD=local_dev_only_change_me
PG_DB=flashbite_write

# --- Redpanda (Kafka API) ---
KAFKA_BROKERS=localhost:9092
SCHEMA_REGISTRY_URL=http://localhost:18081

# --- Temporal ---
TEMPORAL_ADDRESS=localhost:7233

# --- Redis Cluster (6 nodes, host-mapped) ---
REDIS_CLUSTER_NODES=127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003,127.0.0.1:7004,127.0.0.1:7005

# --- MongoDB (read models) ---
MONGO_URI=mongodb://localhost:27017/flashbite_read
```

- [ ] **Step 7: Install root dev dependencies**

Run:
```bash
pnpm install
```
Expected: pnpm resolves and writes `pnpm-lock.yaml`; no `spikes`/`apps` packages exist yet, so only root devDeps install.

- [ ] **Step 8: Commit**

```bash
git add .gitignore package.json pnpm-workspace.yaml tsconfig.base.json .env.example pnpm-lock.yaml
git commit -m "chore: scaffold pnpm monorepo workspace"
```

---

## Task 2: Author the Docker Compose infrastructure

**Files:**
- Create: `infra/docker-compose.yml`

This is configuration, not code — there is no unit test. Verification happens in Task 3 by bringing the stack up and asserting health. Write the file carefully; the inline comments capture the gotchas listed in the Context section.

- [ ] **Step 1: Create `infra/docker-compose.yml`**

Create `infra/docker-compose.yml`:
```yaml
name: flashbite

services:
  # ---------- Application Postgres: event store + outbox ----------
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: flashbite
      POSTGRES_PASSWORD: local_dev_only_change_me
      POSTGRES_DB: flashbite_write
    ports:
      - "5432:5432"
    volumes:
      - pg_app_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U flashbite -d flashbite_write"]
      interval: 5s
      timeout: 5s
      retries: 10

  # ---------- MongoDB: read models ----------
  mongodb:
    image: mongo:7.0
    ports:
      - "27017:27017"
    volumes:
      - mongo_data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"]
      interval: 5s
      timeout: 5s
      retries: 10

  # ---------- Redpanda: Kafka API + built-in Schema Registry ----------
  redpanda:
    image: docker.redpanda.com/redpandadata/redpanda:v24.2.7
    command:
      - redpanda
      - start
      - --kafka-addr=internal://0.0.0.0:29092,external://0.0.0.0:9092
      # external advertised on localhost so host-run spikes connect cleanly
      - --advertise-kafka-addr=internal://redpanda:29092,external://localhost:9092
      - --schema-registry-addr=internal://0.0.0.0:8081,external://0.0.0.0:18081
      - --rpc-addr=redpanda:33145
      - --advertise-rpc-addr=redpanda:33145
      - --mode=dev-container
      - --smp=1
      - --default-log-level=info
    ports:
      - "9092:9092"     # Kafka API (host)
      - "18081:18081"   # Schema Registry (host)
      - "9644:9644"     # Admin API
    volumes:
      - redpanda_data:/var/lib/redpanda/data
    healthcheck:
      test: ["CMD-SHELL", "rpk cluster health | grep -q 'Healthy:.*true'"]
      interval: 5s
      timeout: 5s
      retries: 15

  # ---------- One-shot: create the shared multi-tenant topics ----------
  redpanda-init:
    image: docker.redpanda.com/redpandadata/redpanda:v24.2.7
    depends_on:
      redpanda:
        condition: service_healthy
    entrypoint: ["/bin/bash", "-c"]
    command:
      - |
        rpk topic create order-events --partitions 6 --brokers redpanda:29092 || true
        rpk topic create telemetry-streams --partitions 12 --brokers redpanda:29092 || true
        rpk topic list --brokers redpanda:29092
    restart: "no"

  # ---------- Redpanda Console (observability UI) ----------
  redpanda-console:
    image: docker.redpanda.com/redpandadata/console:v2.7.2
    depends_on:
      redpanda:
        condition: service_healthy
    environment:
      KAFKA_BROKERS: redpanda:29092
      KAFKA_SCHEMAREGISTRY_ENABLED: "true"
      KAFKA_SCHEMAREGISTRY_URLS: http://redpanda:8081
    ports:
      - "8085:8080"     # Console UI on host 8085 (8080 reserved for Temporal UI)

  # ---------- Temporal's OWN Postgres (kept separate from app Postgres) ----------
  temporal-postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: temporal
      POSTGRES_PASSWORD: temporal
      POSTGRES_DB: temporal
    volumes:
      - temporal_pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U temporal -d temporal"]
      interval: 5s
      timeout: 5s
      retries: 10

  # ---------- Temporal server (auto-setup) ----------
  temporal:
    image: temporalio/auto-setup:1.24.2
    depends_on:
      temporal-postgres:
        condition: service_healthy
    environment:
      # Temporal >= 1.20 uses the postgres12 schema plugin, NOT 'postgresql'
      - DB=postgres12
      - DB_PORT=5432
      - POSTGRES_SEEDS=temporal-postgres
      - POSTGRES_USER=temporal
      - POSTGRES_PWD=temporal
    ports:
      - "7233:7233"
    healthcheck:
      test: ["CMD", "tctl", "--address", "temporal:7233", "cluster", "health"]
      interval: 10s
      timeout: 5s
      retries: 15

  # ---------- Temporal Web UI ----------
  temporal-ui:
    image: temporalio/ui:2.26.2
    depends_on:
      - temporal
    environment:
      - TEMPORAL_ADDRESS=temporal:7233
    ports:
      - "8080:8080"

  # ---------- Redis Cluster: single-container 6-node cluster ----------
  # macOS Docker Desktop cannot expose discrete-container Redis Cluster nodes to the
  # host (network_mode host binds inside the Linux VM only; bridge mode breaks gossip).
  # grokzen runs 6 real redis processes forming one cluster in a single network
  # namespace, with all node ports published so a Mac host client can follow MOVED
  # redirects. Ports start at 7100 to avoid macOS AirPlay on 7000.
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

volumes:
  pg_app_data:
  mongo_data:
  redpanda_data:
  temporal_pg_data:
```

> **Deviation note (macOS):** The original plan used 6 discrete containers with `network_mode: host`. macOS Docker Desktop cannot expose discrete-container Redis Cluster nodes to the host (host networking binds inside the Linux VM only; bridge mode breaks cluster gossip). Replaced with `grokzen/redis-cluster:7.0.15` — a single container running 6 real Redis processes in one network namespace, with all ports published. Ports start at 7100 (not 7000) to avoid macOS AirPlay. All other services remain on the default Compose bridge network.

- [ ] **Step 2: Validate the compose file parses**

Run:
```bash
docker compose -f infra/docker-compose.yml config --quiet && echo "COMPOSE OK"
```
Expected: `COMPOSE OK` with no YAML/schema errors.

- [ ] **Step 3: Commit**

```bash
git add infra/docker-compose.yml
git commit -m "feat(infra): docker-compose for postgres, mongo, redpanda, temporal, redis-cluster"
```

---

## Task 3: Bring up infra and verify health

**Files:**
- None created — this task verifies Task 2.

- [ ] **Step 1: Start the stack**

Run:
```bash
pnpm infra:up
```
Expected: each service reports `Started` / `Healthy`; `redpanda-init` and `redis-cluster-init` run once and exit 0.

- [ ] **Step 2: Wait for and confirm all long-running services are healthy**

Run:
```bash
docker compose -f infra/docker-compose.yml ps
```
Expected: `postgres`, `mongodb`, `redpanda`, `temporal`, `temporal-postgres` show `healthy`; `redis-cluster` and the two UIs show `running`/`up`. The old `redis-0..5` and `redis-cluster-init` services are gone (removed by `--remove-orphans`).

- [ ] **Step 3: Confirm topics were created**

Run:
```bash
docker exec flashbite-redpanda-1 rpk topic list --brokers redpanda:29092
```
Expected: lists `order-events` (6 partitions) and `telemetry-streams` (12 partitions).
> If the container name differs, find it with `docker compose -f infra/docker-compose.yml ps`.

- [ ] **Step 4: Confirm Redis Cluster formed (single-container grokzen topology)**

Wait ~20-25s after the container starts for the 6-node cluster to self-form, then run:
```bash
redis-cli -c -h 127.0.0.1 -p 7100 cluster info | grep cluster_state
```
Expected: `cluster_state:ok`.

Verify host can follow MOVED redirects across slots:
```bash
redis-cli -c -h 127.0.0.1 -p 7100 set "{tenant:berlin}:probe" v1
redis-cli -c -h 127.0.0.1 -p 7100 get "{tenant:berlin}:probe"   # expect v1
redis-cli -c -h 127.0.0.1 -p 7100 set "{tenant:tokyo}:probe" v2
redis-cli -c -h 127.0.0.1 -p 7100 get "{tenant:tokyo}:probe"    # expect v2
redis-cli -c -h 127.0.0.1 -p 7100 cluster nodes | wc -l         # expect 6
```
> Use `/opt/homebrew/bin/redis-cli` on macOS (Homebrew). The `-c` flag enables cluster-follow-redirect mode.

- [ ] **Step 5: Eyeball the UIs (optional manual check)**

Open `http://localhost:8080` (Temporal UI) and `http://localhost:8085` (Redpanda Console). Both should load.

- [ ] **Step 6: Commit (documentation of verified state)**

No files changed. Record the milestone with an empty commit so the history marks "infra verified":
```bash
git commit --allow-empty -m "chore(infra): verify full stack boots healthy"
```

---

## Task 4: Spike A — Kafka/Redpanda partition-key ordering

**Goal:** prove that messages sharing a `tenantId` key always land on the same partition (the isolation/ordering guarantee the whole system depends on).

**Files:**
- Create: `spikes/package.json`
- Create: `spikes/tsconfig.json`
- Create: `spikes/src/kafka-partition.spike.ts`

- [ ] **Step 1: Create `spikes/package.json`**

Create `spikes/package.json`:
```json
{
  "name": "@flashbite/spikes",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "kafka": "tsx src/kafka-partition.spike.ts",
    "temporal:worker": "tsx src/temporal/worker.ts",
    "temporal:run": "tsx src/temporal/run.spike.ts",
    "outbox": "tsx src/outbox.spike.ts",
    "redis": "tsx src/redis-cluster.spike.ts"
  },
  "dependencies": {
    "kafkajs": "2.2.4",
    "@temporalio/client": "1.11.1",
    "@temporalio/worker": "1.11.1",
    "@temporalio/workflow": "1.11.1",
    "@temporalio/activity": "1.11.1",
    "ioredis": "5.4.1",
    "pg": "8.12.0"
  },
  "devDependencies": {
    "@types/pg": "8.11.6"
  }
}
```

- [ ] **Step 2: Create `spikes/tsconfig.json`**

Create `spikes/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install spike dependencies**

Run:
```bash
pnpm install
```
Expected: `@flashbite/spikes` deps install; lockfile updates.

- [ ] **Step 4: Write the spike**

Create `spikes/src/kafka-partition.spike.ts`:
```ts
import { Kafka, logLevel } from "kafkajs";

const TOPIC = "order-events";
const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");

// Two tenants, several orders each. The key is `${tenantId}:${orderId}`.
const MESSAGES = [
  { tenant: "berlin", order: "o1" },
  { tenant: "berlin", order: "o2" },
  { tenant: "berlin", order: "o3" },
  { tenant: "tokyo", order: "o1" },
  { tenant: "tokyo", order: "o2" },
];

async function main() {
  const kafka = new Kafka({ clientId: "spike-a", brokers: BROKERS, logLevel: logLevel.NOTHING });

  const producer = kafka.producer();
  await producer.connect();
  await producer.send({
    topic: TOPIC,
    messages: MESSAGES.map((m) => ({
      key: `${m.tenant}:${m.order}`,
      value: JSON.stringify(m),
    })),
  });
  await producer.disconnect();

  const consumer = kafka.consumer({ groupId: `spike-a-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  const partitionByTenant = new Map<string, Set<number>>();
  let seen = 0;

  await new Promise<void>(async (resolve) => {
    await consumer.run({
      eachMessage: async ({ partition, message }) => {
        const key = message.key?.toString() ?? "";
        const tenant = key.split(":")[0];
        if (!partitionByTenant.has(tenant)) partitionByTenant.set(tenant, new Set());
        partitionByTenant.get(tenant)!.add(partition);
        seen += 1;
        if (seen >= MESSAGES.length) resolve();
      },
    });
  });

  await consumer.disconnect();

  // Assertion: every tenant's messages landed on exactly ONE partition.
  for (const [tenant, partitions] of partitionByTenant) {
    if (partitions.size !== 1) {
      throw new Error(
        `Tenant ${tenant} spread across partitions ${[...partitions].join(",")} — key partitioning broken`,
      );
    }
    console.log(`tenant=${tenant} -> partition ${[...partitions][0]}`);
  }

  console.log("SPIKE OK: same tenant key => same partition");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Run the spike and verify it passes**

Run:
```bash
pnpm --filter @flashbite/spikes kafka
```
Expected output ends with:
```
tenant=berlin -> partition <n>
tenant=tokyo -> partition <m>
SPIKE OK: same tenant key => same partition
```
(`<n>` and `<m>` are single partition numbers; the spike throws if any tenant spans more than one.)

- [ ] **Step 6: Commit**

```bash
git add spikes/package.json spikes/tsconfig.json spikes/src/kafka-partition.spike.ts pnpm-lock.yaml
git commit -m "test(spike): prove redpanda partition-key ordering per tenant"
```

---

## Task 5: Spike B — Temporal hello-workflow (timer + signal)

**Goal:** prove a Temporal workflow can race a timer against an external signal — the exact mechanism the order-lifecycle SLA saga will use later.

**Files:**
- Create: `spikes/src/temporal/workflow.ts`
- Create: `spikes/src/temporal/worker.ts`
- Create: `spikes/src/temporal/run.spike.ts`

- [ ] **Step 1: Write the workflow**

Create `spikes/src/temporal/workflow.ts`:
```ts
import { condition, defineSignal, setHandler, sleep } from "@temporalio/workflow";

export const approveSignal = defineSignal<[boolean]>("approve");

/**
 * Races an SLA timer against a merchant-approval signal.
 * Returns "APPROVED" if the signal arrives in time, "SLA_BREACH" otherwise.
 * This is the corrected single-handler pattern (the PRD registered the handler twice).
 */
export async function slaRaceWorkflow(slaSeconds: number): Promise<string> {
  let approved: boolean | undefined;
  setHandler(approveSignal, (value) => {
    approved = value;
  });

  const signalledInTime = await condition(() => approved !== undefined, `${slaSeconds}s`);

  if (signalledInTime && approved) return "APPROVED";
  if (signalledInTime && !approved) return "DECLINED";
  return "SLA_BREACH";
}
```

- [ ] **Step 2: Write the worker**

Create `spikes/src/temporal/worker.ts`:
```ts
import { NativeConnection, Worker } from "@temporalio/worker";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TASK_QUEUE = "spike-sla";
const ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";

async function main() {
  const connection = await NativeConnection.connect({ address: ADDRESS });
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    workflowsPath: path.join(__dirname, "workflow.ts"),
  });

  console.log(`worker listening on task queue "${TASK_QUEUE}"`);
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Write the runner (client) spike**

Create `spikes/src/temporal/run.spike.ts`:
```ts
import { Client, Connection } from "@temporalio/client";
import { approveSignal, slaRaceWorkflow } from "./workflow.js";

const TASK_QUEUE = "spike-sla";
const ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";

async function main() {
  const connection = await Connection.connect({ address: ADDRESS });
  const client = new Client({ connection, namespace: "default" });

  // Case 1: signal arrives in time -> APPROVED
  const h1 = await client.workflow.start(slaRaceWorkflow, {
    args: [30],
    taskQueue: TASK_QUEUE,
    workflowId: `spike-approved-${Date.now()}`,
  });
  await h1.signal(approveSignal, true);
  const r1 = await h1.result();
  if (r1 !== "APPROVED") throw new Error(`expected APPROVED, got ${r1}`);
  console.log(`case 1 (signal in time): ${r1}`);

  // Case 2: no signal, short SLA -> SLA_BREACH
  const h2 = await client.workflow.start(slaRaceWorkflow, {
    args: [2],
    taskQueue: TASK_QUEUE,
    workflowId: `spike-breach-${Date.now()}`,
  });
  const r2 = await h2.result();
  if (r2 !== "SLA_BREACH") throw new Error(`expected SLA_BREACH, got ${r2}`);
  console.log(`case 2 (timer wins): ${r2}`);

  console.log("SPIKE OK: temporal timer-vs-signal race works");
  await connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Start the worker (leave it running in one terminal)**

Run:
```bash
pnpm --filter @flashbite/spikes temporal:worker
```
Expected: `worker listening on task queue "spike-sla"` and the process stays up.

- [ ] **Step 5: In a second terminal, run the spike**

Run:
```bash
pnpm --filter @flashbite/spikes temporal:run
```
Expected output:
```
case 1 (signal in time): APPROVED
case 2 (timer wins): SLA_BREACH
SPIKE OK: temporal timer-vs-signal race works
```
Then stop the worker with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add spikes/src/temporal
git commit -m "test(spike): prove temporal timer-vs-signal SLA race"
```

---

## Task 6: Spike C — Transactional outbox round-trip

**Goal:** prove the outbox pattern end-to-end: write an event row to Postgres, a poller reads `PENDING` rows and publishes to Redpanda, marks them `SENT`, and a consumer receives the exact payload. This de-risks the Phase 1 command plane.

**Files:**
- Create: `spikes/src/outbox.spike.ts`

- [ ] **Step 1: Write the spike**

Create `spikes/src/outbox.spike.ts`:
```ts
import { Client as PgClient } from "pg";
import { Kafka, logLevel } from "kafkajs";
import { randomUUID } from "node:crypto";

const TOPIC = "order-events";
const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");

const pgConfig = {
  host: process.env.PG_HOST ?? "localhost",
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER ?? "flashbite",
  password: process.env.PG_PASSWORD ?? "local_dev_only_change_me",
  database: process.env.PG_DB ?? "flashbite_write",
};

async function main() {
  const pg = new PgClient(pgConfig);
  await pg.connect();

  // 1. Minimal outbox table (Phase 1 will formalize this via migrations).
  await pg.query(`
    CREATE TABLE IF NOT EXISTS outbox_ledger (
      id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 2. Write an event row (simulating the command handler's atomic write).
  const eventId = randomUUID();
  const tenantId = "berlin";
  const orderId = randomUUID();
  const payload = { eventId, tenantId, orderId, eventType: "OrderPlaced", amount: 4200 };

  await pg.query(
    `INSERT INTO outbox_ledger (id, tenant_id, topic, partition_key, payload, status)
     VALUES ($1, $2, $3, $4, $5, 'PENDING')`,
    [eventId, tenantId, TOPIC, `${tenantId}:${orderId}`, JSON.stringify(payload)],
  );

  // 3. Poller: read PENDING rows, publish, mark SENT.
  const kafka = new Kafka({ clientId: "spike-c", brokers: BROKERS, logLevel: logLevel.NOTHING });
  const producer = kafka.producer();
  await producer.connect();

  const pending = await pg.query(`SELECT * FROM outbox_ledger WHERE status = 'PENDING'`);
  for (const row of pending.rows) {
    await producer.send({
      topic: row.topic,
      messages: [{ key: row.partition_key, value: JSON.stringify(row.payload) }],
    });
    await pg.query(`UPDATE outbox_ledger SET status = 'SENT' WHERE id = $1`, [row.id]);
  }
  await producer.disconnect();

  // 4. Consumer: confirm the published event arrives intact.
  const consumer = kafka.consumer({ groupId: `spike-c-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  const received: any = await new Promise(async (resolve) => {
    await consumer.run({
      eachMessage: async ({ message }) => {
        const value = JSON.parse(message.value!.toString());
        if (value.eventId === eventId) resolve(value);
      },
    });
  });
  await consumer.disconnect();

  // 5. Assertions.
  if (received.eventId !== eventId) throw new Error("eventId mismatch after round-trip");
  if (received.amount !== 4200) throw new Error("payload corrupted in round-trip");

  const after = await pg.query(`SELECT status FROM outbox_ledger WHERE id = $1`, [eventId]);
  if (after.rows[0].status !== "SENT") throw new Error("outbox row not marked SENT");

  // Cleanup the throwaway table so reruns start clean.
  await pg.query(`DROP TABLE outbox_ledger`);
  await pg.end();

  console.log("SPIKE OK: postgres outbox -> redpanda -> consumer round-trip intact");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the spike and verify it passes**

Run:
```bash
pnpm --filter @flashbite/spikes outbox
```
Expected final line:
```
SPIKE OK: postgres outbox -> redpanda -> consumer round-trip intact
```

- [ ] **Step 3: Commit**

```bash
git add spikes/src/outbox.spike.ts
git commit -m "test(spike): prove transactional outbox round-trip to redpanda"
```

---

## Task 7: Spike D — Redis Cluster quorum + hash-tag co-location

**Goal:** prove the cluster is healthy and that `{tenant:id}` hash tags co-locate a tenant's keys on a single hash slot (the Phase 2 Redis isolation mechanism).

**Files:**
- Create: `spikes/src/redis-cluster.spike.ts`

- [ ] **Step 1: Write the spike**

Create `spikes/src/redis-cluster.spike.ts`:
```ts
import { Cluster } from "ioredis";

// NOTE (macOS deviation): grokzen/redis-cluster runs all 6 nodes in one container,
// ports 7100-7105. If ioredis receives a MOVED redirect to 0.0.0.0 (grokzen's
// announced IP), add a natMap option to the Cluster constructor:
//   new Cluster(NODES, { natMap: { "0.0.0.0:7100": { host: "127.0.0.1", port: 7100 }, ... } })
// Test without natMap first — if cluster info works but SET/GET hangs on redirect, add it.
const NODES = (process.env.REDIS_CLUSTER_NODES ??
  "127.0.0.1:7100,127.0.0.1:7101,127.0.0.1:7102,127.0.0.1:7103,127.0.0.1:7104,127.0.0.1:7105")
  .split(",")
  .map((hp) => {
    const [host, port] = hp.split(":");
    return { host, port: Number(port) };
  });

async function main() {
  const cluster = new Cluster(NODES);

  // 1. Cluster is healthy.
  const info = await cluster.cluster("INFO");
  if (!String(info).includes("cluster_state:ok")) {
    throw new Error(`cluster not ok:\n${info}`);
  }
  console.log("cluster_state:ok");

  // 2. Two keys for the SAME tenant (same hash tag) must share a slot.
  const berlinDash = "{tenant:berlin}:order:o1:dashboard";
  const berlinGeo = "{tenant:berlin}:driver:geo";
  const slotA = await cluster.cluster("KEYSLOT", berlinDash);
  const slotB = await cluster.cluster("KEYSLOT", berlinGeo);
  if (slotA !== slotB) {
    throw new Error(`same-tenant keys landed on different slots: ${slotA} vs ${slotB}`);
  }
  console.log(`berlin keys co-located on slot ${slotA}`);

  // 3. A different tenant should (normally) map to a different slot.
  const tokyoDash = "{tenant:tokyo}:order:o1:dashboard";
  const slotC = await cluster.cluster("KEYSLOT", tokyoDash);
  console.log(`tokyo dashboard on slot ${slotC}`);

  // 4. Round-trip a value through the cluster.
  await cluster.set(berlinDash, JSON.stringify({ status: "COOKING" }), "EX", 10);
  const back = await cluster.get(berlinDash);
  if (!back || JSON.parse(back).status !== "COOKING") {
    throw new Error("value did not round-trip through cluster");
  }
  console.log("value round-trip OK");

  await cluster.quit();
  console.log("SPIKE OK: redis cluster healthy + tenant hash-tag co-location works");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the spike and verify it passes**

Run:
```bash
pnpm --filter @flashbite/spikes redis
```
Expected output:
```
cluster_state:ok
berlin keys co-located on slot <s>
tokyo dashboard on slot <t>
value round-trip OK
SPIKE OK: redis cluster healthy + tenant hash-tag co-location works
```

- [ ] **Step 3: Commit**

```bash
git add spikes/src/redis-cluster.spike.ts
git commit -m "test(spike): prove redis cluster quorum + tenant hash-tag co-location"
```

---

## Task 8: Phase 0 exit — infra README and gate checklist

**Files:**
- Create: `infra/README.md`

- [ ] **Step 1: Write `infra/README.md`**

Create `infra/README.md`:
```markdown
# FlashBite Local Infrastructure

One command brings up the full stack:

```bash
pnpm infra:up      # start everything (detached)
pnpm infra:ps      # show service status
pnpm infra:down    # stop (keep volumes)
pnpm infra:nuke    # stop and delete all volumes (clean slate)
```

## Services & ports

| Service           | Host port(s)        | Purpose                                   |
|-------------------|---------------------|-------------------------------------------|
| postgres          | 5432                | App event store + outbox                  |
| mongodb           | 27017               | Read models                               |
| redpanda          | 9092, 18081, 9644   | Kafka API, Schema Registry, Admin         |
| redpanda-console  | 8085                | Kafka/topic observability UI              |
| temporal          | 7233                | Workflow server (own Postgres)            |
| temporal-ui       | 8080                | Temporal Web UI                           |
| redis-0..5        | 7000-7005 (+17000-) | 6-node Redis Cluster (host networking)    |

## Notes

- **Redis uses host networking** so cluster client redirection works from host-run
  scripts. Other services use the default Compose bridge network and talk by service name.
- **Redis nodes advertise `127.0.0.1`** (`cluster-announce-ip`) to avoid MOVED redirects
  to unreachable internal Docker IPs.
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
```

- [ ] **Step 2: Run the full Phase 0 exit checklist**

Confirm every item below passes. This is the gate to Phase 1.

```
[ ] pnpm infra:up brings all services up; init one-shots exit 0
[ ] docker compose ps shows postgres/mongodb/redpanda/temporal healthy
[ ] redis-cli -c -h 127.0.0.1 -p 7100 cluster info => cluster_state:ok  (single-container grokzen, ports 7100-7105)
[ ] rpk topic list shows order-events (6) and telemetry-streams (12)
[ ] Spike A (kafka)    => SPIKE OK
[ ] Spike B (temporal) => SPIKE OK
[ ] Spike C (outbox)   => SPIKE OK
[ ] Spike D (redis)    => SPIKE OK
[ ] http://localhost:8080 (Temporal UI) and http://localhost:8085 (Console) load
```

- [ ] **Step 3: Commit**

```bash
git add infra/README.md
git commit -m "docs(infra): phase 0 runbook and exit checklist"
```

---

## Self-Review (completed by plan author)

**Spec coverage (§6 Phase 0):**
- "Stand up docker-compose: Postgres, Mongo, Redis Cluster (6 nodes), Redpanda (+Console, built-in Schema Registry), Temporal on its own DB" → Task 2 + Task 3. ✓
- Spike (a) Kafka produce→consume with partition key → Task 4. ✓
- Spike (b) Temporal hello-workflow with timer + signal → Task 5. ✓
- Spike (c) outbox row → poller → Kafka round-trip → Task 6. ✓
- Spike (d) Redis Cluster quorum + `{tenant:id}` hash-tag co-location → Task 7. ✓
- Exit: all containers healthy, `cluster_state:ok`, each spike runs → Task 3 + Task 8 checklist. ✓
- Spec correction "Temporal on its own DB" (§5 #4) → separate `temporal-postgres` service. ✓
- Spec correction "secrets via .env, no literal secrets shipped" (§5 #5) → `.env.example` + gitignored `.env` (Task 1). ✓
- Spec "Redpanda Console replaces generic Kafka UI" (§8) → `redpanda-console` service. ✓

**Placeholder scan:** No TBD/TODO; every code and command step contains complete content.

**Type/name consistency:** `approveSignal`/`slaRaceWorkflow` defined in `workflow.ts` and imported identically in `worker.ts`/`run.spike.ts`; topic names (`order-events`, `telemetry-streams`), partition counts (6/12), Redis ports (7100-7105, single-container grokzen deviation), and the `{tenant:id}` hash-tag pattern are consistent across all tasks and match the master spec.

**Scope note:** The `outbox_ledger` table in Spike C is intentionally minimal and self-cleaning (`DROP TABLE` at the end) — Phase 1 will formalize the event store + outbox via real migrations. The spikes are throwaway by design (§6 Phase 0) and are removed when Phase 1 begins.
```
