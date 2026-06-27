import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { CorrelationMiddleware, CORRELATION_LOGGER } from "@flashbite/tenant-context";
import { createLogger } from "@flashbite/shared";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [
    { provide: CORRELATION_LOGGER, useFactory: () => createLogger("identity") },
    CorrelationMiddleware,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
