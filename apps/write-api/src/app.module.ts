import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { AuthMiddleware, CorrelationMiddleware, CORRELATION_LOGGER, RolesGuard, TenantGuard, TokenVerifier } from "@flashbite/tenant-context";
import { createLogger, PrismaService, TenantCatalogService } from "@flashbite/shared";
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
    PrismaService,
    { provide: TenantCatalogService, useFactory: (p: PrismaService) => new TenantCatalogService(p), inject: [PrismaService] },
    { provide: APP_GUARD, useFactory: (catalog: TenantCatalogService) => new TenantGuard(catalog), inject: [TenantCatalogService] },
    { provide: CORRELATION_LOGGER, useFactory: () => createLogger("write-api") },
    CorrelationMiddleware,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
    consumer.apply(AuthMiddleware).exclude("health").forRoutes("*");
  }
}
