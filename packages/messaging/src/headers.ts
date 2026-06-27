import { randomUUID } from "node:crypto";
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
    correlationId: meta.correlationId,
  };
}

/** Headers that must be present and non-empty — a message lacking any is malformed. */
const REQUIRED_HEADERS = ["eventType", "tenantId", "eventId"] as const;

/**
 * Reconstructs envelope metadata from Kafka headers (values arrive as Buffers).
 * Fails closed: throws if a required header (eventType/tenantId/eventId) is missing
 * or empty, so a malformed message is loud rather than silently defaulting — an empty
 * tenantId would otherwise bypass tenant scoping / RLS, and an empty eventType would
 * misroute. version/occurredAt remain lenient.
 */
export function parseHeaders(headers: IHeaders | undefined): EnvelopeMeta {
  const h = headers ?? {};
  const s = (k: string): string => (h[k] == null ? "" : h[k]!.toString());
  const missing = REQUIRED_HEADERS.filter((k) => s(k) === "");
  if (missing.length > 0) {
    throw new Error(`Kafka message missing required envelope header(s): ${missing.join(", ")}`);
  }
  return {
    eventType: s("eventType"),
    tenantId: s("tenantId"),
    eventId: s("eventId"),
    version: Number(s("version") || 0),
    occurredAt: s("occurredAt"),
    correlationId: s("correlationId") || randomUUID(),
  };
}
