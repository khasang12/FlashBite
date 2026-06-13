import { Kafka, logLevel } from "kafkajs";
import { PrismaService, loadConfig } from "@flashbite/shared";
import { pollOnce } from "./poller";

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000);

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

  // eslint-disable-next-line no-console
  console.log("outbox-poller running");
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
    const sent = await pollOnce(prisma, producer);
    if (sent === 0) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
