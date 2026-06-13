import { Kafka, logLevel } from "kafkajs";

const TOPIC = "order-events";
const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");

// Production keys messages by `${tenantId}:${orderId}` (the aggregate id), so every
// event in a single order's lifecycle lands on the same partition IN SEQUENCE.
// We emit a multi-event lifecycle per order and prove the per-order co-location.
const ORDERS = [
  { tenant: "berlin", order: "o1" },
  { tenant: "berlin", order: "o2" },
  { tenant: "tokyo", order: "o1" },
];
const EVENT_TYPES = ["OrderPlaced", "OrderAccepted", "OrderFulfilled"];

const MESSAGES = ORDERS.flatMap((o) =>
  EVENT_TYPES.map((event) => ({ ...o, event })),
);

const orderKey = (m: { tenant: string; order: string }) => `${m.tenant}:${m.order}`;

async function main() {
  const kafka = new Kafka({ clientId: "spike-a", brokers: BROKERS, logLevel: logLevel.NOTHING });

  // Step 1: record high-water marks so we know where OUR messages start.
  const admin = kafka.admin();
  await admin.connect();
  const watermarks = await admin.fetchTopicOffsets(TOPIC);
  await admin.disconnect();

  // partition -> offset (exclusive lower bound for this run's messages)
  const startOffsets = new Map<number, bigint>(
    watermarks.map((w) => [w.partition, BigInt(w.high)]),
  );

  // Step 2: produce — key is `${tenantId}:${orderId}` so an order's whole event
  // stream hashes to one partition.
  const producer = kafka.producer();
  await producer.connect();
  await producer.send({
    topic: TOPIC,
    messages: MESSAGES.map((m) => ({
      key: orderKey(m),
      value: JSON.stringify(m),
    })),
  });
  await producer.disconnect();

  // Step 3: consume with seek to our recorded offsets so we only read what we produced.
  const groupId = `spike-a-${Date.now()}`;
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();

  // Seek each partition to the high-water mark we captured before producing.
  consumer.on(consumer.events.GROUP_JOIN, () => {
    for (const [partition, offset] of startOffsets) {
      consumer.seek({ topic: TOPIC, partition, offset: offset.toString() });
    }
  });

  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  // orderKey -> set of partitions it landed on (must be exactly one)
  const partitionByOrder = new Map<string, Set<number>>();
  let seen = 0;

  await new Promise<void>((resolve, reject) => {
    consumer
      .run({
        eachMessage: async ({ partition, message }) => {
          const msgOffset = BigInt(message.offset);
          const start = startOffsets.get(partition) ?? 0n;

          // Only process messages produced in this run.
          if (msgOffset < start) return;

          const key = message.key?.toString() ?? "";
          if (!partitionByOrder.has(key)) partitionByOrder.set(key, new Set());
          partitionByOrder.get(key)!.add(partition);
          seen += 1;
          if (seen >= MESSAGES.length) resolve();
        },
      })
      .catch(reject);
  });

  await consumer.disconnect();

  // Assertion: every order's events landed on exactly ONE partition.
  for (const [key, partitions] of partitionByOrder) {
    if (partitions.size !== 1) {
      throw new Error(
        `Order ${key} spread across partitions ${[...partitions].join(",")} — key partitioning broken`,
      );
    }
    console.log(`order=${key} -> partition ${[...partitions][0]}`);
  }

  console.log("SPIKE OK: same tenantId:orderId key => same partition (per-order ordering)");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
