import { Body, Controller, Get, HttpCode, Param, Post, Query, UsePipes, ValidationPipe } from "@nestjs/common";
import { RedisService } from "@flashbite/shared";
import { DriverLocationDto } from "./driver-location.dto";
import { TelemetryProducerService } from "./telemetry-producer.service";
import { currentTenant, scopedGeoKey } from "../tenant-scope";

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
    const tenantId = currentTenant();
    await this.telemetry.publish(tenantId, { driverId, lng: dto.lng, lat: dto.lat, orderId: dto.orderId });
    return { driverId };
  }

  @Get("nearby")
  async nearby(
    @Query("lng") lng: string,
    @Query("lat") lat: string,
    @Query("radiusKm") radiusKm = "5",
  ): Promise<NearbyDriver[]> {
    const raw = (await this.redis.cluster.geosearch(
      scopedGeoKey(),
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
