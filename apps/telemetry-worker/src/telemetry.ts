import type { Cluster } from "ioredis";
import { driverGeoKey, type EventEnvelope, type DriverTelemetryPayload } from "@flashbite/contracts";

/**
 * Writes one driver GPS ping into the tenant's Redis geo set. Ephemeral — no
 * Postgres. GEOADD is idempotent per member (latest position wins).
 */
export async function applyTelemetry(cluster: Cluster, envelope: EventEnvelope): Promise<void> {
  const p = envelope.payload as DriverTelemetryPayload;
  await cluster.geoadd(driverGeoKey(envelope.tenantId), p.lng, p.lat, p.driverId);
}
