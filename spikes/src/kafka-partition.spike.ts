import { Kafka, logLevel } from "kafkajs";

const TOPIC = "order-events";
const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");

// Two tenants, several orders each.
// The partition key is the tenantId so all orders for a tenant land on one partition.
const MESSAGES = [
  { tenant: "berlin", order: "o1" },
  { tenant: "berlin", order: "o2" },
  { tenant: "berlin", order: "o3" },
  { tenant: "tokyo", order: "o1" },
  { tenant: "tokyo", order: "o2" },
];

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

  // Step 2: produce — key is tenantId only so all orders for a tenant hash to the same partition.
  const producer = kafka.producer();
  await producer.connect();
  await producer.send({
    topic: TOPIC,
    messages: MESSAGES.map((m) => ({
      key: m.tenant,
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

  const partitionByTenant = new Map<string, Set<number>>();
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
          // key is the tenantId directly.
          const tenant = key;
          if (!partitionByTenant.has(tenant)) partitionByTenant.set(tenant, new Set());
          partitionByTenant.get(tenant)!.add(partition);
          seen += 1;
          if (seen >= MESSAGES.length) resolve();
        },
      })
      .catch(reject);
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
