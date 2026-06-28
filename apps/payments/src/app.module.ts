import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { CorrelationMiddleware, LoggerModule } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";
import { PaymentsModule } from "./payments.module";

@Module({
  imports: [LoggerModule.forRoot("payments"), PaymentsModule],
  controllers: [HealthController],
  providers: [CorrelationMiddleware],
})
export class AppModule implements NestModule {
  // payments is a saga-internal service (no Bearer token) — correlation-only, NOT AuthMiddleware.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
