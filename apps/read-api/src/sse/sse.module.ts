import { Module } from "@nestjs/common";
import { OrderStreamService } from "./order-stream.service";
import { SseFeederService } from "./sse-feeder.service";
import { MerchantSseController } from "./merchant-sse.controller";

@Module({
  controllers: [MerchantSseController],
  providers: [OrderStreamService, SseFeederService],
  exports: [OrderStreamService],
})
export class SseModule {}
