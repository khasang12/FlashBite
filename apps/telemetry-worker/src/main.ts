import { Kafka, logLevel, type Consumer } from "kafkajs";
import type { Cluster } from "ioredis";
import { createLogger, createRedisCluster, loadConfig, runWithObsContext } from "@flashbite/shared";
import { CONSUMER_GROUPS, TOPICS } from "@flashbite/contracts";
import { createRegistry, readEnvelope, type SchemaRegistry } from "@flashbite/messaging";
import { applyTelemetry } from "./telemetry";

const log = createLogger("telemetry-worker");

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
      await runWithObsContext(
        { correlationId: envelope.correlationId, tenantId: envelope.tenantId, eventId: envelope.eventId },
        async () => { await applyTelemetry(cluster, envelope); log.info({ eventType: envelope.eventType }, "consumed"); },
      );
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

  log.info("telemetry-worker running");
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
    log.error(err, "fatal");
    process.exit(1);
  });
}
