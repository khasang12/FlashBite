import type { Tenant } from "../store/tenant-store";
import type { GeoPoint } from "./random-walk";

export type CityCenter = GeoPoint;

// Seed positions for the simulated GPS emitter, per tenant.
export const CITY_CENTERS: Record<Tenant, CityCenter> = {
  berlin: { lng: 13.405, lat: 52.52 },
  tokyo: { lng: 139.7, lat: 35.68 },
};
