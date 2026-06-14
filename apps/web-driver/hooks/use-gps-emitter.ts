"use client";
import { useEffect, useState } from "react";
import {
  reportLocation,
  getNearbyDrivers,
  randomWalk,
  CITY_CENTERS,
  type GeoPoint,
  type NearbyDriver,
  type Tenant,
} from "@flashbite/web-shared";

const TICK_MS = 2000;
const STEP_DEG = 0.0008;
const RADIUS_KM = 5;

export interface GpsState {
  position: GeoPoint | null;
  nearby: NearbyDriver[];
  pings: number;
  reconnecting: boolean;
}

const IDLE: GpsState = { position: null, nearby: [], pings: 0, reconnecting: false };

export function useGpsEmitter(tenant: Tenant, driverId: string, online: boolean): GpsState {
  const [state, setState] = useState<GpsState>(IDLE);

  useEffect(() => {
    if (!online) {
      setState(IDLE);
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let pos: GeoPoint = { ...CITY_CENTERS[tenant] };
    let pings = 0;

    const tick = async (): Promise<void> => {
      pos = randomWalk(pos, STEP_DEG);

      let reconnecting = false;
      try {
        await reportLocation(tenant, driverId, { lng: pos.lng, lat: pos.lat });
        pings += 1;
      } catch {
        reconnecting = true; // transient — keep looping
      }

      let fetched: NearbyDriver[] | null = null;
      try {
        fetched = await getNearbyDrivers(tenant, pos.lng, pos.lat, RADIUS_KM);
      } catch {
        fetched = null; // keep last results
      }

      if (!active) return;
      setState((prev) => ({
        position: { ...pos },
        nearby: fetched ?? prev.nearby,
        pings,
        reconnecting,
      }));
      timer = setTimeout(() => void tick(), TICK_MS);
    };

    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [tenant, driverId, online]);

  return state;
}
