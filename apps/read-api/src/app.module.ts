import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { TenantMiddleware } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";
import { SseModule } from "./sse/sse.module";

@Module({
  imports: [OrdersModule, SseModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
