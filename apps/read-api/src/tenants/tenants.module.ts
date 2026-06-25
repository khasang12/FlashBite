import { Module } from "@nestjs/common";
import { PrismaService, TenantCatalogService } from "@flashbite/shared";
import { TenantsController } from "./tenants.controller";

@Module({
  controllers: [TenantsController],
  providers: [
    PrismaService,
    { provide: TenantCatalogService, useFactory: (p: PrismaService) => new TenantCatalogService(p), inject: [PrismaService] },
  ],
})
export class TenantsModule {}
