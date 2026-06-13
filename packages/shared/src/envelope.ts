import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@flashbite/contracts";

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
}): EventEnvelope<T> {
  return {
    tenantId: args.tenantId,
    eventId: args.eventId ?? randomUUID(),
    eventType: args.eventType,
    version: args.version,
    occurredAt: args.occurredAt ?? new Date().toISOString(),
    payload: args.payload,
  };
}
