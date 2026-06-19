import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Kafka, logLevel, type Producer } from "kafkajs";
import { buildEnvelope, loadConfig } from "@flashbite/shared";
import { EVENT_TYPES, TOPICS, type DriverTelemetryPayload } from "@flashbite/contracts";
import { createRegistry, publishEnvelope, type SchemaRegistry } from "@flashbite/messaging";

@Injectable()
export class TelemetryProducerService implements OnModuleInit, OnModuleDestroy {
  private producer!: Producer;
  private registry!: SchemaRegistry;

  async onModuleInit(): Promise<void> {
    const config = loadConfig();
    const kafka = new Kafka({ clientId: "read-api-telemetry", brokers: config.kafkaBrokers, logLevel: logLevel.NOTHING });
    this.producer = kafka.producer();
    await this.producer.connect();
    this.registry = createRegistry(config.schemaRegistryUrl);
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer?.disconnect();
  }

  async publish(tenantId: string, payload: DriverTelemetryPayload): Promise<void> {
    // Normalize the optional orderId to explicit null for the Avro ["null","string"] union.
    const envelope = buildEnvelope({
      tenantId,
      eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED,
      version: 1,
      payload: { ...payload, orderId: payload.orderId ?? null } as DriverTelemetryPayload,
    });
    await publishEnvelope(this.producer, this.registry, TOPICS.TELEMETRY_STREAMS, `${tenantId}:${payload.driverId}`, envelope);
  }
}
