import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@flashbite/contracts";
import { getObsContext } from "./obs-context";

/**
 * Builds an event envelope. Lives in @flashbite/shared (not contracts) because it
 * uses node:crypto — keeping @flashbite/contracts pure for the Temporal workflow bundle.
 */
export function buildEnvelope<T>(args: {
  tenantId: string;
  eventType: string;
  version: number;
  payload: T;
  eventId?: string;
  occurredAt?: string;
  correlationId?: string;
}): EventEnvelope<T> {
  return {
    tenantId: args.tenantId,
    eventId: args.eventId ?? randomUUID(),
    eventType: args.eventType,
    version: args.version,
    occurredAt: args.occurredAt ?? new Date().toISOString(),
    correlationId: args.correlationId ?? getObsContext()?.correlationId ?? randomUUID(),
    payload: args.payload,
  };
}
