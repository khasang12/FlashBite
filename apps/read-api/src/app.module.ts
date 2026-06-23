import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthMiddleware, TokenVerifier, TenantGuard } from "@flashbite/tenant-context";
import { PrismaService, TenantCatalogService } from "@flashbite/shared";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";
import { SseModule } from "./sse/sse.module";
import { DriversModule } from "./drivers/drivers.module";
import { AdminModule } from "./admin/admin.module";
import { DispatchModule } from "./dispatch/dispatch.module";
import { TenantsModule } from "./tenants/tenants.module";

@Module({
  imports: [OrdersModule, SseModule, DriversModule, AdminModule, DispatchModule, TenantsModule],
  controllers: [HealthController],
  providers: [
    TokenVerifier,
    PrismaService,
    { provide: TenantCatalogService, useFactory: (p: PrismaService) => new TenantCatalogService(p), inject: [PrismaService] },
    { provide: APP_GUARD, useFactory: (catalog: TenantCatalogService) => new TenantGuard(catalog), inject: [TenantCatalogService] },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).exclude("health").forRoutes("*");
  }
}
