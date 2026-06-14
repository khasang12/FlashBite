"use client";
import { useEffect, useState } from "react";
import {
  useTenantStore, TENANTS, type Tenant,
  toNearbyRows,
  Button,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@flashbite/web-shared";
import { useGpsEmitter } from "@/hooks/use-gps-emitter";
import { NearbyMap } from "@/components/nearby-map";
import { NearbyTable } from "@/components/nearby-table";

const DRIVERS = ["drv-1", "drv-2", "drv-3", "drv-4"];

export default function DriverPage() {
  const tenant = useTenantStore((s) => s.tenant);
  const setTenant = useTenantStore((s) => s.setTenant);
  const [mounted, setMounted] = useState(false);
  const [driverId, setDriverId] = useState("drv-1");
  const [online, setOnline] = useState(false);

  useEffect(() => {
    // Hydration-safe mount flag: the tenant store uses skipHydration, so the tenant
    // <Select> is rendered only after rehydrate to avoid an SSR/client mismatch.
    void useTenantStore.persist.rehydrate();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const { position, nearby, pings, reconnecting } = useGpsEmitter(tenant, driverId, online);
  const rows = toNearbyRows(nearby, driverId);

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="text-lg font-extrabold">
          flashbite <span className="text-muted-foreground font-semibold">driver</span>
        </div>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Select value={driverId} onValueChange={setDriverId}>
            <SelectTrigger className="w-28" aria-label="Select driver">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DRIVERS.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mounted && (
            <Select value={tenant} onValueChange={(v) => setTenant(v as Tenant)}>
              <SelectTrigger className="w-28" aria-label="Select city">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TENANTS.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-6 flex items-center justify-between rounded-xl border px-5 py-4">
          {online ? (
            <div className="flex items-center gap-3">
              <span className="relative inline-flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
              </span>
              <div>
                <div className="font-bold">Online — streaming GPS</div>
                <div className="text-xs text-muted-foreground">
                  {driverId} · {pings} pings sent
                  {position ? ` · ${position.lng.toFixed(4)}, ${position.lat.toFixed(4)}` : ""}
                  {reconnecting ? " · reconnecting…" : ""}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Offline — go online to start streaming your location.</div>
          )}
          <Button
            variant={online ? "secondary" : "default"}
            onClick={() => setOnline((v) => !v)}
            aria-pressed={online}
          >
            {online ? "Go offline" : "Go online"}
          </Button>
        </div>

        {online && (
          <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Nearby · 5km radius
              </div>
              <NearbyMap position={position} nearby={rows} />
            </section>
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Nearby drivers ({rows.length})
              </div>
              <NearbyTable data={rows} />
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
