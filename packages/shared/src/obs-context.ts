import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Per-request / per-message logging context, merged into every log line by the pino mixin. */
export interface ObsContext {
  correlationId: string;
  tenantId?: string;
  eventId?: string;
}

const storage = new AsyncLocalStorage<ObsContext>();

export function runWithObsContext<T>(ctx: ObsContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getObsContext(): ObsContext | undefined {
  return storage.getStore();
}

export function newCorrelationId(): string {
  return randomUUID();
}

/** Flattens the current ObsContext into log fields, omitting absent ones. Used as the pino mixin. */
export function obsLogFields(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  const out: Record<string, string> = { correlationId: ctx.correlationId };
  if (ctx.tenantId) out.tenantId = ctx.tenantId;
  if (ctx.eventId) out.eventId = ctx.eventId;
  return out;
}
