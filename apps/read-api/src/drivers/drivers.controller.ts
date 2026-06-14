import { Body, Controller, Get, HttpCode, Param, Post, Query, UsePipes, ValidationPipe } from "@nestjs/common";
import { getTenantId } from "@flashbite/tenant-context";
import { driverGeoKey } from "@flashbite/contracts";
import { RedisService } from "@flashbite/shared";
import { DriverLocationDto } from "./driver-location.dto";
import { TelemetryProducerService } from "./telemetry-producer.service";

interface NearbyDriver {
  driverId: string;
  distanceKm: number;
  lng: number;
  lat: number;
}

@Controller("drivers")
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class DriversController {
  constructor(
    private readonly telemetry: TelemetryProducerService,
    private readonly redis: RedisService,
  ) {}

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

  @Get("nearby")
  async nearby(
    @Query("lng") lng: string,
    @Query("lat") lat: string,
    @Query("radiusKm") radiusKm = "5",
  ): Promise<NearbyDriver[]> {
    const tenantId = getTenantId();
    const raw = (await this.redis.cluster.geosearch(
      driverGeoKey(tenantId),
      "FROMLONLAT",
      lng,
      lat,
      "BYRADIUS",
      radiusKm,
      "km",
      "ASC",
      "WITHDIST",
      "WITHCOORD",
    )) as Array<[string, string, [string, string]]>;

    return raw.map(([driverId, dist, [dlng, dlat]]) => ({
      driverId,
      distanceKm: Number(dist),
      lng: Number(dlng),
      lat: Number(dlat),
    }));
  }
}
