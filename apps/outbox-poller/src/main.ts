import { Kafka, logLevel } from "kafkajs";
import { PrismaService, loadConfig, createLogger } from "@flashbite/shared";
import { createRegistry } from "@flashbite/messaging";
import { pollOnce } from "./poller";

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000);
const log = createLogger("outbox-poller");

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = new PrismaService();
  await prisma.$connect();

  const kafka = new Kafka({
    clientId: "outbox-poller",
    brokers: config.kafkaBrokers,
    logLevel: logLevel.NOTHING,
  });
  const producer = kafka.producer();
  await producer.connect();
  const registry = createRegistry(config.schemaRegistryUrl);

  log.info("outbox-poller running");
  let running = true;
  const shutdown = async (): Promise<void> => {
    running = false;
    await producer.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    const sent = await pollOnce(prisma, producer, registry);
    if (sent === 0) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});
