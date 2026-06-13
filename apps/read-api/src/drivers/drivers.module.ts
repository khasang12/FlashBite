import { Module } from "@nestjs/common";
import { RedisService } from "@flashbite/shared";
import { DriversController } from "./drivers.controller";
import { TelemetryProducerService } from "./telemetry-producer.service";

@Module({
  controllers: [DriversController],
  providers: [TelemetryProducerService, RedisService],
})
export class DriversModule {}
