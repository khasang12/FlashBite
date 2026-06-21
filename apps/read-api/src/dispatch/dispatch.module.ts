import { Module } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { MongoService } from "@flashbite/shared";
import { RolesGuard } from "@flashbite/tenant-context";
import { DispatchController } from "./dispatch.controller";
import { DispatchQueryService } from "./dispatch-query.service";

@Module({ controllers: [DispatchController], providers: [DispatchQueryService, MongoService, RolesGuard, Reflector] })
export class DispatchModule {}
