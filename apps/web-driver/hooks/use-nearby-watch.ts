"use client";
import { useEffect, useState } from "react";
import {
  getNearbyDrivers,
  CITY_CENTERS,
  type NearbyDriver,
  type Tenant,
} from "@flashbite/web-shared";

const TICK_MS = 2000;
const RADIUS_KM = 5;

export interface NearbyState {
  nearby: NearbyDriver[];
  reconnecting: boolean;
}

const IDLE: NearbyState = { nearby: [], reconnecting: false };

// Read-only watcher: GPS pings are streamed externally (scripts/stream-gps.sh).
// While `watching`, this polls getNearbyDrivers around the tenant city center
// every ~2s and reports what the geo index currently holds.
export function useNearbyWatch(tenant: Tenant, watching: boolean): NearbyState {
  const [state, setState] = useState<NearbyState>(IDLE);

  useEffect(() => {
    if (!watching) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(IDLE);
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const center = CITY_CENTERS[tenant];

    const tick = async (): Promise<void> => {
      let fetched: NearbyDriver[] | null = null;
      try {
        fetched = await getNearbyDrivers(tenant, center.lng, center.lat, RADIUS_KM);
      } catch {
        fetched = null; // transient — keep last results, flag reconnecting
      }

      if (!active) return;
      setState((prev) => ({
        nearby: fetched ?? prev.nearby,
        reconnecting: fetched === null,
      }));
      timer = setTimeout(() => void tick(), TICK_MS);
    };

    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [tenant, watching]);

  return state;
}
