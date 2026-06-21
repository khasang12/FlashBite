"use client";
import { useState } from "react";
import {
  AuthGate, useAuthStore,
  type Tenant,
  CITY_CENTERS, toNearbyRows,
  Button,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@flashbite/web-shared";
import { useNearbyWatch } from "@/hooks/use-nearby-watch";
import { NearbyMap } from "@/components/nearby-map";
import { NearbyTable } from "@/components/nearby-table";

const DRIVERS = ["drv-1", "drv-2", "drv-3", "drv-4"];

const DRIVER_DEMOS = [
  { label: "Berlin drv-1", email: "drv-1@berlin.test" },
  { label: "Berlin drv-2", email: "drv-2@berlin.test" },
  { label: "Tokyo drv-1", email: "drv-1@tokyo.test" },
];

function DriverDashboard() {
  const tenantId = (useAuthStore((s) => s.claims?.tenantId) ?? "berlin") as Tenant;
  const [driverId, setDriverId] = useState("drv-1");
  const [watching, setWatching] = useState(false);

  const center = CITY_CENTERS[tenantId];
  const { nearby, reconnecting } = useNearbyWatch(center, watching);
  // GPS is streamed externally (scripts/stream-gps.sh). The selected driver shows
  // as "you" when its ping appears in the geo index; everyone else is in the table.
  const self = nearby.find((d) => d.driverId === driverId) ?? null;
  const others = toNearbyRows(nearby, driverId);
  const mapCenter = self ? { lng: self.lng, lat: self.lat } : center;

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
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-6 flex items-center justify-between rounded-xl border px-5 py-4">
          {watching ? (
            <div className="flex items-center gap-3">
              <span className="relative inline-flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
              </span>
              <div>
                <div className="font-bold">Watching — live nearby</div>
                <div className="text-xs text-muted-foreground">
                  {tenantId} · {others.length} nearby
                  {self
                    ? ` · you (${driverId}): ${self.lng.toFixed(4)}, ${self.lat.toFixed(4)}`
                    : ` · ${driverId} not streaming yet`}
                  {reconnecting ? " · reconnecting…" : ""}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              Not watching — start to see nearby drivers (stream GPS via scripts/stream-gps.sh).
            </div>
          )}
          <Button
            variant={watching ? "secondary" : "default"}
            onClick={() => setWatching((v) => !v)}
            aria-pressed={watching}
          >
            {watching ? "Stop watching" : "Start watching"}
          </Button>
        </div>

        {watching && (
          <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Nearby · 5km radius
              </div>
              <NearbyMap center={mapCenter} self={self} nearby={others} />
            </section>
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Nearby drivers ({others.length})
              </div>
              <NearbyTable data={others} />
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default function DriverPage() {
  return (
    <AuthGate demoUsers={DRIVER_DEMOS} requiredRole="driver" title="FlashBite — Driver">
      <DriverDashboard />
    </AuthGate>
  );
}
