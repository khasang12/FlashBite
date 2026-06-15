import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { AuthMiddleware, TokenVerifier } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";
import { SseModule } from "./sse/sse.module";
import { DriversModule } from "./drivers/drivers.module";

@Module({
  imports: [OrdersModule, SseModule, DriversModule],
  controllers: [HealthController],
  providers: [TokenVerifier],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).exclude("health").forRoutes("*");
  }
}
