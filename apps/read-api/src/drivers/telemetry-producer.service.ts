import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Kafka, logLevel, type Producer } from "kafkajs";
import { buildEnvelope, loadConfig } from "@flashbite/shared";
import { EVENT_TYPES, TOPICS, type DriverTelemetryPayload } from "@flashbite/contracts";

@Injectable()
export class TelemetryProducerService implements OnModuleInit, OnModuleDestroy {
  private producer!: Producer;

  async onModuleInit(): Promise<void> {
    const kafka = new Kafka({ clientId: "read-api-telemetry", brokers: loadConfig().kafkaBrokers, logLevel: logLevel.NOTHING });
    this.producer = kafka.producer();
    await this.producer.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer?.disconnect();
  }

  async publish(tenantId: string, payload: DriverTelemetryPayload): Promise<void> {
    const envelope = buildEnvelope({
      tenantId,
      eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED,
      version: 1,
      payload,
    });
    await this.producer.send({
      topic: TOPICS.TELEMETRY_STREAMS,
      messages: [{ key: `${tenantId}:${payload.driverId}`, value: JSON.stringify(envelope) }],
    });
  }
}
