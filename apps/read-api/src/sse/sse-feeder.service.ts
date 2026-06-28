import { Injectable, OnModuleInit, OnModuleDestroy, Inject } from "@nestjs/common";
import { Kafka, logLevel, type Consumer } from "kafkajs";
import { loadConfig, runWithObsContext } from "@flashbite/shared";
import { APP_LOGGER, type Logger } from "@flashbite/tenant-context";
import {
  CONSUMER_GROUPS,
  DISPATCH_STATUS,
  EVENT_TYPES,
  ORDER_STATUS,
  TOPICS,
  type DispatchAcceptedPayload,
  type DispatchFailedPayload,
  type DispatchView,
  type DriverOfferedPayload,
  type EventEnvelope,
  type OrderPlacedPayload,
} from "@flashbite/contracts";
import { createRegistry, readEnvelope } from "@flashbite/messaging";
import { OrderStreamService } from "./order-stream.service";
import { DispatchStreamService } from "./dispatch-stream.service";

/** Maps an order-events envelope to the merchant SSE event shape. */
export function toStreamEvent(envelope: EventEnvelope) {
  const p = envelope.payload as Partial<OrderPlacedPayload> & { reason?: string };
  const cancelReason = envelope.eventType === EVENT_TYPES.ORDER_CANCELLED ? p.reason : undefined;
  return { orderId: p.orderId ?? "", eventType: envelope.eventType, status: ORDER_STATUS.PLACED, cancelReason };
}

/** Maps a dispatch-events envelope to a DispatchView; null for unrelated events.
 *  Mirrors applyDispatchEvent in the projection worker. */
export function toDispatchView(envelope: EventEnvelope): DispatchView | null {
  const orderId = (envelope.payload as { orderId: string }).orderId;
  const base = { tenantId: envelope.tenantId, orderId, version: envelope.version, updatedAt: envelope.occurredAt };
  switch (envelope.eventType) {
    case EVENT_TYPES.DRIVER_OFFERED:
      return { ...base, status: DISPATCH_STATUS.OFFERED, offeredDriverId: (envelope.payload as DriverOfferedPayload).driverId };
    case EVENT_TYPES.DISPATCH_ACCEPTED:
      return { ...base, status: DISPATCH_STATUS.DISPATCHED, driverId: (envelope.payload as DispatchAcceptedPayload).driverId };
    case EVENT_TYPES.ORDER_PICKED_UP:
      return { ...base, status: DISPATCH_STATUS.PICKED_UP };
    case EVENT_TYPES.ORDER_DELIVERED:
      return { ...base, status: DISPATCH_STATUS.DELIVERED };
    case EVENT_TYPES.DISPATCH_FAILED:
      return { ...base, status: DISPATCH_STATUS.FAILED, reason: (envelope.payload as DispatchFailedPayload).reason };
    default:
      return null;
  }
}

@Injectable()
export class SseFeederService implements OnModuleInit, OnModuleDestroy {
  private consumer!: Consumer;
  constructor(
    private readonly stream: OrderStreamService,
    private readonly dispatchStream: DispatchStreamService,
    @Inject(APP_LOGGER) private readonly log: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    const config = loadConfig();
    const registry = createRegistry(config.schemaRegistryUrl);
    const kafka = new Kafka({ clientId: CONSUMER_GROUPS.READ_API_SSE, brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
    this.consumer = kafka.consumer({ groupId: `${CONSUMER_GROUPS.READ_API_SSE}-${process.pid}` });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });
    await this.consumer.subscribe({ topic: TOPICS.DISPATCH_EVENTS, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        const envelope = await readEnvelope(registry, message);
        if (!envelope) return;
        await runWithObsContext(
          { correlationId: envelope.correlationId, tenantId: envelope.tenantId, eventId: envelope.eventId },
          async () => {
            if (topic === TOPICS.DISPATCH_EVENTS) {
              const view = toDispatchView(envelope);
              if (view) this.dispatchStream.publish(envelope.tenantId, view);
              this.log.info({ eventType: envelope.eventType }, "consumed");
              return;
            }
            this.stream.publish(envelope.tenantId, toStreamEvent(envelope));
            this.log.info({ eventType: envelope.eventType }, "consumed");
          },
        );
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
