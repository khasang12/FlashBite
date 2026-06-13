import path from "node:path";
import { Worker, NativeConnection } from "@temporalio/worker";
import { WorkflowIdReusePolicy } from "@temporalio/client";
import { Kafka, logLevel, type Consumer } from "kafkajs";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, loadConfig, type TemporalHandle } from "@flashbite/shared";
import {
  CONSUMER_GROUPS,
  EVENT_TYPES,
  ORDER_SAGA,
  TOPICS,
  type EventEnvelope,
  type OrderPlacedPayload,
} from "@flashbite/contracts";
import { createActivities } from "./activities";

export interface SagaWorkerHandle {
  stop: () => Promise<void>;
}

/** Boots the Temporal worker (workflows + activities). Returns a stop handle. */
export async function startSagaWorker(): Promise<SagaWorkerHandle> {
  const config = loadConfig();
  const prisma = new PrismaClient();
  await prisma.$connect();

  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: ORDER_SAGA.TASK_QUEUE,
    workflowsPath: path.join(__dirname, "workflows.ts"),
    activities: createActivities(prisma),
  });
  const runPromise = worker.run();

  return {
    stop: async () => {
      worker.shutdown();
      await runPromise.catch(() => undefined);
      await connection.close();
      await prisma.$disconnect();
    },
  };
}

/** Kafka consumer: start one workflow per OrderPlaced. Returns a stop handle. */
export async function startOrderConsumer(
  consumer: Consumer,
  temporal: TemporalHandle,
  slaSeconds: number,
): Promise<SagaWorkerHandle> {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const envelope = JSON.parse(message.value.toString()) as EventEnvelope;
      if (envelope.eventType !== EVENT_TYPES.ORDER_PLACED) return;
      const p = envelope.payload as OrderPlacedPayload;
      try {
        await temporal.client.workflow.start(ORDER_SAGA.WORKFLOW_TYPE, {
          taskQueue: ORDER_SAGA.TASK_QUEUE,
          workflowId: `${envelope.tenantId}:${p.orderId}`,
          workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
          args: [{ tenantId: envelope.tenantId, orderId: p.orderId, totalAmount: p.totalAmount, slaSeconds }],
        });
      } catch (err) {
        if (!/already started|WorkflowExecutionAlreadyStarted/i.test(String(err))) throw err;
      }
    },
  });
  return {
    stop: async () => {
      await consumer.disconnect();
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const saga = await startSagaWorker();
  const temporal = await connectTemporal();
  const kafka = new Kafka({ clientId: "saga-worker", brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.SAGA });
  const orderConsumer = await startOrderConsumer(consumer, temporal, config.sagaSlaSeconds);

  // eslint-disable-next-line no-console
  console.log("saga-worker running");

  const shutdown = async (): Promise<void> => {
    await orderConsumer.stop();
    await temporal.connection.close();
    await saga.stop();
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
