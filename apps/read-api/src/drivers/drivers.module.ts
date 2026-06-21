import { Module } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RedisService } from "@flashbite/shared";
import { RolesGuard } from "@flashbite/tenant-context";
import { DriversController } from "./drivers.controller";
import { TelemetryProducerService } from "./telemetry-producer.service";

@Module({
  controllers: [DriversController],
  providers: [TelemetryProducerService, RedisService, RolesGuard, Reflector],
})
export class DriversModule {}
