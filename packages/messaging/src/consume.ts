import type { KafkaMessage } from "kafkajs";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import type { EventEnvelope } from "@flashbite/contracts";
import { decodePayload } from "./serde";
import { parseHeaders } from "./headers";

/** Decodes a Kafka message into the EventEnvelope shape (headers + Avro payload). */
export async function readEnvelope(registry: SchemaRegistry, message: KafkaMessage): Promise<EventEnvelope | null> {
  if (!message.value) return null;
  const payload = await decodePayload(registry, message.value);
  return { ...parseHeaders(message.headers), payload };
}
