import { DynamicModule, Module } from "@nestjs/common";
import { createLogger } from "@flashbite/shared";

/** DI token for the app-wide pino logger. Inject with `@Inject(APP_LOGGER) private readonly log: Logger`. */
export const APP_LOGGER = "APP_LOGGER";

export type { Logger } from "pino";

/**
 * Global module that provides the app's pino logger under APP_LOGGER so NestJS services inject it
 * instead of calling createLogger() in every file. The pino mixin still attaches the obsContext
 * (correlationId/tenantId/eventId) to every line. Each app registers it once:
 *   imports: [LoggerModule.forRoot("write-api")]
 *
 * Plain-TS workers (outbox-poller, projection/saga/telemetry) have no Nest DI container, so they
 * keep calling createLogger() directly.
 */
@Module({})
export class LoggerModule {
  static forRoot(service: string): DynamicModule {
    return {
      module: LoggerModule,
      global: true,
      providers: [{ provide: APP_LOGGER, useValue: createLogger(service) }],
      exports: [APP_LOGGER],
    };
  }
}
