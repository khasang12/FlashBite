import { Kafka, logLevel, type Consumer } from "kafkajs";
import type { Cluster } from "ioredis";
import { createRedisCluster, loadConfig } from "@flashbite/shared";
import { CONSUMER_GROUPS, TOPICS } from "@flashbite/contracts";
import { createRegistry, readEnvelope, type SchemaRegistry } from "@flashbite/messaging";
import { applyTelemetry } from "./telemetry";

export interface TelemetryConsumerHandle {
  stop: () => Promise<void>;
}

/** Wires a kafkajs consumer to applyTelemetry (Avro decode + header metadata). */
export async function runTelemetryConsumer(consumer: Consumer, cluster: Cluster, registry: SchemaRegistry): Promise<TelemetryConsumerHandle> {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.TELEMETRY_STREAMS, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const envelope = await readEnvelope(registry, message);
      if (!envelope) return;
      await applyTelemetry(cluster, envelope);
    },
  });
  return { stop: async () => { await consumer.disconnect(); } };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const cluster = createRedisCluster();
  const kafka = new Kafka({ clientId: "telemetry-worker", brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.TELEMETRY });
  const registry = createRegistry(config.schemaRegistryUrl);
  const handle = await runTelemetryConsumer(consumer, cluster, registry);

  // eslint-disable-next-line no-console
  console.log("telemetry-worker running");
  const shutdown = async (): Promise<void> => {
    await handle.stop();
    await cluster.quit();
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
