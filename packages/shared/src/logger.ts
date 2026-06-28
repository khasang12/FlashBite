import pino, { type Logger } from "pino";
import { obsLogFields } from "./obs-context";

/**
 * Structured JSON logger. JSON to stdout in production and under test; pretty in dev. The mixin
 * attaches the current obsContext (correlationId/tenantId/eventId) to every line, so call sites
 * pass none. The pino-pretty transport runs in a worker thread, which leaves an open handle and
 * races under Jest's parallel workers — so it is disabled in production and whenever running under
 * Jest (detected via JEST_WORKER_ID, which Jest sets in every worker regardless of NODE_ENV).
 */
export function createLogger(service: string): Logger {
  const underJest = process.env.JEST_WORKER_ID !== undefined;
  const pretty = process.env.NODE_ENV !== "production" && !underJest;
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service },
    mixin: () => obsLogFields(),
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:standard", ignore: "pid,hostname" } } }
      : {}),
  });
}
