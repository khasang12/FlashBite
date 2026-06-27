import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { CorrelationMiddleware } from "@flashbite/tenant-context";
import { createLogger } from "@flashbite/shared";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [
    { provide: CorrelationMiddleware, useFactory: () => new CorrelationMiddleware(createLogger("identity")) },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
