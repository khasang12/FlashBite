import { Kafka, logLevel, type Consumer } from "kafkajs";
import type { Db } from "mongodb";
import { connectMongo, createLogger, loadConfig, runWithObsContext } from "@flashbite/shared";
import { CONSUMER_GROUPS, TOPICS } from "@flashbite/contracts";
import { createRegistry, readEnvelope, type SchemaRegistry } from "@flashbite/messaging";
import { applyEvent } from "./projection";
import { applyDispatchEvent } from "./dispatch-projection";

const log = createLogger("projection-worker");

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
      await runWithObsContext(
        { correlationId: envelope.correlationId, tenantId: envelope.tenantId, eventId: envelope.eventId },
        async () => { await applyEvent(db, envelope); log.info({ eventType: envelope.eventType }, "projected"); },
      );
    },
  });
  return { stop: async () => { await consumer.disconnect(); } };
}

/** Wires a kafkajs consumer to applyDispatchEvent for the dispatch-events topic. */
export async function runDispatchConsumer(consumer: Consumer, db: Db, registry: SchemaRegistry): Promise<ConsumerHandle> {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.DISPATCH_EVENTS, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const envelope = await readEnvelope(registry, message);
      if (!envelope) return;
      await runWithObsContext(
        { correlationId: envelope.correlationId, tenantId: envelope.tenantId, eventId: envelope.eventId },
        async () => { await applyDispatchEvent(db, envelope); log.info({ eventType: envelope.eventType }, "projected"); },
      );
    },
  });
  return { stop: async () => { await consumer.disconnect(); } };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { client, db } = await connectMongo();
  const kafka = new Kafka({ clientId: "projection-worker", brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
  const registry = createRegistry(config.schemaRegistryUrl);

  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.PROJECTION });
  const handle = await runConsumer(consumer, db, registry);

  const dispatchConsumer = kafka.consumer({ groupId: CONSUMER_GROUPS.DISPATCH_PROJECTION });
  const dispatchHandle = await runDispatchConsumer(dispatchConsumer, db, registry);

  log.info("projection-worker running");
  const shutdown = async (): Promise<void> => {
    await handle.stop();
    await dispatchHandle.stop();
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    log.error(err, "fatal");
    process.exit(1);
  });
}
