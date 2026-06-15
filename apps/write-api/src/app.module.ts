import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { AuthMiddleware, RolesGuard, TokenVerifier } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";

@Module({
  imports: [OrdersModule],
  controllers: [HealthController],
  providers: [
    TokenVerifier,
    Reflector,
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector) => new RolesGuard(reflector),
      inject: [Reflector],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).exclude("health").forRoutes("*");
  }
}
