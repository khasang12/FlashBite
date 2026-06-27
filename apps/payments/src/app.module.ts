import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { AuthMiddleware, CorrelationMiddleware, TokenVerifier } from "@flashbite/tenant-context";
import { createLogger } from "@flashbite/shared";
import { HealthController } from "./health.controller";
import { PaymentsModule } from "./payments.module";

@Module({
  imports: [PaymentsModule],
  controllers: [HealthController],
  providers: [
    TokenVerifier,
    { provide: CorrelationMiddleware, useFactory: () => new CorrelationMiddleware(createLogger("payments")) },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
    consumer.apply(AuthMiddleware).exclude("health").forRoutes("*");
  }
}
