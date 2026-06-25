import { Module } from "@nestjs/common";
import { MongoService, RedisService, PrismaService, TenantCatalogService } from "@flashbite/shared";
import { RolesGuard } from "@flashbite/tenant-context";
import { Reflector } from "@nestjs/core";
import { SseModule } from "../sse/sse.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [SseModule],
  controllers: [AdminController],
  providers: [
    AdminService, MongoService, RedisService, RolesGuard, Reflector,
    PrismaService,
    { provide: TenantCatalogService, useFactory: (p: PrismaService) => new TenantCatalogService(p), inject: [PrismaService] },
  ],
})
export class AdminModule {}
