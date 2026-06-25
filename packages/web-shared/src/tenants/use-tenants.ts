"use client";
import { useEffect, useState } from "react";
import type { TenantView } from "@flashbite/contracts";
import { getTenants } from "../api/client";

// Module-level cache + in-flight promise: the catalog is read-heavy / write-rare, so we fetch it
// once per app session and share it across every component (deduped). A mid-session change needs
// a reload — consistent with the backend catalog's TTL eventual-consistency model.
let cache: TenantView[] | null = null;
let inflight: Promise<TenantView[]> | null = null;

function load(): Promise<TenantView[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = getTenants()
      .then((t) => { cache = t; return t; })
      .catch((e) => { inflight = null; throw e; }); // allow a later retry on failure
  }
  return inflight;
}

/** The active tenant catalog, fetched once and shared. `loading` is true until the first load settles. */
export function useTenants(): { tenants: TenantView[]; loading: boolean } {
  const [tenants, setTenants] = useState<TenantView[]>(cache ?? []);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    if (cache) { setTenants(cache); setLoading(false); return; }
    let active = true;
    load()
      .then((t) => { if (active) { setTenants(t); setLoading(false); } })
      .catch(() => { if (active) setLoading(false); }); // error -> empty list, not loading
    return () => { active = false; };
  }, []);

  return { tenants, loading };
}
