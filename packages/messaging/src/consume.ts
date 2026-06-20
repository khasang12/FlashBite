import type { KafkaMessage } from "kafkajs";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import type { EventEnvelope } from "@flashbite/contracts";
import { decodePayload } from "./serde";
import { parseHeaders } from "./headers";

/** Decodes a Kafka message into the EventEnvelope shape (headers + Avro payload). */
export async function readEnvelope(registry: SchemaRegistry, message: KafkaMessage): Promise<EventEnvelope | null> {
  if (!message.value) return null;
  // Validate required metadata before the registry round-trip so a malformed message fails fast.
  const meta = parseHeaders(message.headers);
  const payload = await decodePayload(registry, message.value);
  return { ...meta, payload };
}
