import { Module } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { MongoService } from "@flashbite/shared";
import { RolesGuard } from "@flashbite/tenant-context";
import { OrderStreamService } from "./order-stream.service";
import { DispatchStreamService } from "./dispatch-stream.service";
import { SseFeederService } from "./sse-feeder.service";
import { MerchantSseController } from "./merchant-sse.controller";
import { DriverSseController } from "./driver-sse.controller";
import { DispatchQueryService } from "../dispatch/dispatch-query.service";

@Module({
  controllers: [MerchantSseController, DriverSseController],
  providers: [
    OrderStreamService,
    DispatchStreamService,
    SseFeederService,
    DispatchQueryService,
    MongoService,
    RolesGuard,
    Reflector,
  ],
  exports: [OrderStreamService, DispatchStreamService],
})
export class SseModule {}
