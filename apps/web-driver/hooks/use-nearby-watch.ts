"use client";
import { useEffect, useState } from "react";
import {
  getNearbyDrivers,
  type NearbyDriver,
} from "@flashbite/web-shared";

const TICK_MS = 2000;
const RADIUS_KM = 5;

export interface NearbyState {
  nearby: NearbyDriver[];
  reconnecting: boolean;
  loading: boolean;
}

const IDLE: NearbyState = { nearby: [], reconnecting: false, loading: false };

// Read-only watcher: GPS pings are streamed externally (scripts/stream-gps.sh).
// While `watching`, this polls getNearbyDrivers around the tenant city center
// every ~2s and reports what the geo index currently holds.
// Tenant isolation is enforced server-side by the Bearer token.
export function useNearbyWatch(
  center: { lng: number; lat: number },
  watching: boolean,
): NearbyState {
  const [state, setState] = useState<NearbyState>(IDLE);

  useEffect(() => {
    if (!watching) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(IDLE);
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async (): Promise<void> => {
      let fetched: NearbyDriver[] | null = null;
      try {
        fetched = await getNearbyDrivers(center.lng, center.lat, RADIUS_KM);
      } catch {
        fetched = null; // transient — keep last results, flag reconnecting
      }

      if (!active) return;
      setState((prev) => ({
        nearby: fetched ?? prev.nearby,
        reconnecting: fetched === null,
        loading: false,
      }));
      timer = setTimeout(() => void tick(), TICK_MS);
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((prev) => ({ ...prev, loading: prev.nearby.length === 0 })); // entering watch: skeleton until first poll
    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [center.lng, center.lat, watching]);

  return state;
}
