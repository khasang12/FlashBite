import type { Tenant } from "../store/tenant-store";
import type { GeoPoint } from "./types";

export type CityCenter = GeoPoint;

// Per-tenant map/query anchor: where the driver view centers and runs its
// nearby query (GPS pings themselves are streamed externally via scripts/stream-gps.sh).
export const CITY_CENTERS: Record<Tenant, CityCenter> = {
  berlin: { lng: 13.405, lat: 52.52 },
  tokyo: { lng: 139.7, lat: 35.68 },
};
