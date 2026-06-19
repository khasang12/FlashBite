import type { Producer } from "kafkajs";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { SUBJECTS, subjectFor, type EventEnvelope } from "@flashbite/contracts";
import { encodePayload } from "./serde";
import { buildHeaders } from "./headers";

/**
 * Publishes an event: Avro-encodes the payload (value) and carries the envelope
 * metadata in Kafka headers. Producers are lookup-only — encode fails loudly if
 * the subject is not registered.
 */
export async function publishEnvelope(
  producer: Producer,
  registry: SchemaRegistry,
  topic: string,
  key: string,
  envelope: EventEnvelope,
): Promise<void> {
  const entry = SUBJECTS.find((s) => s.eventType === envelope.eventType);
  if (!entry) throw new Error(`No Avro subject for eventType ${envelope.eventType}`);
  const value = await encodePayload(registry, subjectFor(topic, entry.recordName), envelope.payload);
  await producer.send({ topic, messages: [{ key, value, headers: buildHeaders(envelope) }] });
}
