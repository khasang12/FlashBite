import { Kafka, logLevel, type Consumer } from "kafkajs";
import type { Db } from "mongodb";
import { connectMongo, loadConfig } from "@flashbite/shared";
import { CONSUMER_GROUPS, TOPICS } from "@flashbite/contracts";
import { createRegistry, readEnvelope, type SchemaRegistry } from "@flashbite/messaging";
import { applyEvent } from "./projection";

export interface ConsumerHandle {
  stop: () => Promise<void>;
}

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

async function main(): Promise<void> {
  const config = loadConfig();
  const { client, db } = await connectMongo();
  const kafka = new Kafka({ clientId: "projection-worker", brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.PROJECTION });
  const registry = createRegistry(config.schemaRegistryUrl);
  const handle = await runConsumer(consumer, db, registry);

  // eslint-disable-next-line no-console
  console.log("projection-worker running");
  const shutdown = async (): Promise<void> => {
    await handle.stop();
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
