import { randomUUID } from "node:crypto";
import { createRedisCluster, buildEnvelope } from "@flashbite/shared";
import { EVENT_TYPES, driverGeoKey, type DriverTelemetryPayload } from "@flashbite/contracts";
import { applyTelemetry } from "../src/telemetry";

describe("applyTelemetry", () => {
  const cluster = createRedisCluster();
  afterAll(async () => {
    await cluster.quit();
  });

  const ping = (driverId: string, lng: number, lat: number) =>
    buildEnvelope({
      tenantId: "berlin",
      eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED,
      version: 1,
      payload: { driverId, lng, lat } as DriverTelemetryPayload,
    });

  it("GEOADDs a driver into the tenant geo key and is queryable", async () => {
    const driverId = `d-${randomUUID()}`;
    await applyTelemetry(cluster, ping(driverId, 13.405, 52.52)); // Berlin

    const pos = (await cluster.geopos(driverGeoKey("berlin"), driverId)) as Array<[string, string] | null>;
    expect(pos[0]).not.toBeNull();
    expect(Number(pos[0]![0])).toBeCloseTo(13.405, 2);

    await cluster.zrem(driverGeoKey("berlin"), driverId);
  });

  it("isolates tenants — a berlin driver is absent from tokyo's geo key", async () => {
    const driverId = `d-${randomUUID()}`;
    await applyTelemetry(cluster, ping(driverId, 13.405, 52.52));
    const tokyoPos = (await cluster.geopos(driverGeoKey("tokyo"), driverId)) as Array<[string, string] | null>;
    expect(tokyoPos[0]).toBeNull();
    await cluster.zrem(driverGeoKey("berlin"), driverId);
  });
});
