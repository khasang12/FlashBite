import { Module } from "@nestjs/common";
import { DriversController } from "./drivers.controller";
import { TelemetryProducerService } from "./telemetry-producer.service";

@Module({
  controllers: [DriversController],
  providers: [TelemetryProducerService],
})
export class DriversModule {}
