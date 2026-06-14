import type { NearbyDriver } from "../api/client";

// Drop the caller's own ping from the nearby list (the backend GEOSEARCH may
// include the caller). Order is preserved (backend already sorts by distance).
export function toNearbyRows(nearby: NearbyDriver[], selfDriverId: string): NearbyDriver[] {
  return nearby.filter((d) => d.driverId !== selfDriverId);
}

export function formatKm(km: number): string {
  return `${km.toFixed(2)} km`;
}
