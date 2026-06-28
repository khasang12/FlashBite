import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { CorrelationMiddleware, CORRELATION_LOGGER } from "@flashbite/tenant-context";
import { createLogger } from "@flashbite/shared";
import { HealthController } from "./health.controller";
import { PaymentsModule } from "./payments.module";

@Module({
  imports: [PaymentsModule],
  controllers: [HealthController],
  providers: [
    { provide: CORRELATION_LOGGER, useFactory: () => createLogger("payments") },
    CorrelationMiddleware,
  ],
})
export class AppModule implements NestModule {
  // payments is a saga-internal service (no Bearer token) — correlation-only, NOT AuthMiddleware.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
