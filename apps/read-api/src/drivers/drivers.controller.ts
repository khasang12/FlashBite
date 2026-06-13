import { Body, Controller, HttpCode, Param, Post, UsePipes, ValidationPipe } from "@nestjs/common";
import { getTenantId } from "@flashbite/tenant-context";
import { DriverLocationDto } from "./driver-location.dto";
import { TelemetryProducerService } from "./telemetry-producer.service";

@Controller("drivers")
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class DriversController {
  constructor(private readonly telemetry: TelemetryProducerService) {}

  @Post(":driverId/location")
  @HttpCode(202)
  async reportLocation(
    @Param("driverId") driverId: string,
    @Body() dto: DriverLocationDto,
  ): Promise<{ driverId: string }> {
    const tenantId = getTenantId();
    await this.telemetry.publish(tenantId, { driverId, lng: dto.lng, lat: dto.lat, orderId: dto.orderId });
    return { driverId };
  }
}
