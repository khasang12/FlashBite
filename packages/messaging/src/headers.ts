import type { IHeaders } from "kafkajs";
import type { EventEnvelope } from "@flashbite/contracts";

/** Envelope minus its payload — the metadata carried in Kafka headers. */
export type EnvelopeMeta = Omit<EventEnvelope, "payload">;

/** Serializes envelope metadata to string Kafka headers. */
export function buildHeaders(meta: EnvelopeMeta): Record<string, string> {
  return {
    eventType: meta.eventType,
    tenantId: meta.tenantId,
    eventId: meta.eventId,
    version: String(meta.version),
    occurredAt: meta.occurredAt,
  };
}

/** Reconstructs envelope metadata from Kafka headers (values arrive as Buffers). */
export function parseHeaders(headers: IHeaders | undefined): EnvelopeMeta {
  const h = headers ?? {};
  const s = (k: string): string => (h[k] == null ? "" : h[k]!.toString());
  return {
    eventType: s("eventType"),
    tenantId: s("tenantId"),
    eventId: s("eventId"),
    version: Number(s("version") || 0),
    occurredAt: s("occurredAt"),
  };
}
