import pg from "pg";
const { Client: PgClient } = pg;
import { Kafka, logLevel } from "kafkajs";
import { randomUUID } from "node:crypto";

const TOPIC = "order-events";
const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");

const pgConfig = {
  host: process.env.PG_HOST ?? "localhost",
  port: Number(process.env.PG_PORT ?? 5434),
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
