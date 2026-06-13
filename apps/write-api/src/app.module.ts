import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { TenantMiddleware } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";

@Module({
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
