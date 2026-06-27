import pino, { type Logger } from "pino";
import { obsLogFields } from "./obs-context";

/**
 * Structured JSON logger. JSON to stdout in production; pretty in dev. The mixin attaches the
 * current obsContext (correlationId/tenantId/eventId) to every line, so call sites pass none.
 */
export function createLogger(service: string): Logger {
  const pretty = process.env.NODE_ENV !== "production";
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service },
    mixin: () => obsLogFields(),
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:standard", ignore: "pid,hostname" } } }
      : {}),
  });
}
