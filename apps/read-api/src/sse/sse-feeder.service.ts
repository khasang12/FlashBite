import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Kafka, logLevel, type Consumer } from "kafkajs";
import { loadConfig } from "@flashbite/shared";
import {
  CONSUMER_GROUPS,
  ORDER_STATUS,
  TOPICS,
  type EventEnvelope,
  type OrderPlacedPayload,
} from "@flashbite/contracts";
import { OrderStreamService } from "./order-stream.service";

/** Maps an order-events envelope to the merchant SSE event shape. */
export function toStreamEvent(envelope: EventEnvelope) {
  const p = envelope.payload as Partial<OrderPlacedPayload>;
  return { orderId: p.orderId ?? "", eventType: envelope.eventType, status: ORDER_STATUS.PLACED };
}

@Injectable()
export class SseFeederService implements OnModuleInit, OnModuleDestroy {
  private consumer!: Consumer;
  constructor(private readonly stream: OrderStreamService) {}

  async onModuleInit(): Promise<void> {
    const config = loadConfig();
    const kafka = new Kafka({ clientId: CONSUMER_GROUPS.READ_API_SSE, brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
    this.consumer = kafka.consumer({ groupId: `${CONSUMER_GROUPS.READ_API_SSE}-${process.pid}` });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const envelope = JSON.parse(message.value.toString()) as EventEnvelope;
        this.stream.publish(envelope.tenantId, toStreamEvent(envelope));
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
