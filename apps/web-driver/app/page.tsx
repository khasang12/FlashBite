"use client";
import { useCallback, useEffect, useState } from "react";
import {
  AuthGate, useAuthStore, useTenants,
  type Tenant, type DispatchView,
  toNearbyRows,
  DISPATCH_STATUS,
  useDispatchStream,
  acceptDispatch, rejectDispatch, pickupOrder, deliverOrder, getDriverOnline,
} from "@flashbite/web-shared";
import { useNearbyWatch } from "@/hooks/use-nearby-watch";
import { NearbyMap } from "@/components/nearby-map";
import { NearbyTable } from "@/components/nearby-table";
import { OnlineToggle } from "@/components/online-toggle";
import { OfferCard } from "@/components/offer-card";
import { ActiveJobCard } from "@/components/active-job-card";

const DRIVER_DEMOS = [
  { label: "Berlin drv-1", email: "drv-1@berlin.test" },
  { label: "Berlin drv-2", email: "drv-2@berlin.test" },
  { label: "Tokyo drv-1", email: "drv-1@tokyo.test" },
];

function DriverDashboard() {
  const tenantId = (useAuthStore((s) => s.claims?.tenantId) ?? "berlin") as Tenant;
  const driverId = useAuthStore((s) => s.claims?.sub) ?? "";
  const [online, setOnline] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);

  // Reconcile the toggle from the backend on load — the driver may still be in the online set
  // from a previous session even though this is a fresh page mount.
  useEffect(() => {
    if (!driverId) return;
    let cancelled = false;
    getDriverOnline(driverId).then((o) => { if (!cancelled) setOnline(o); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [driverId]);

  const { dispatch } = useDispatchStream(driverId);
  // An offer is only actionable while the driver is online — an offline driver isn't taking jobs,
  // so we never present an Accept button to them. We also drop offers the driver has dismissed
  // (rejected/expired) locally and any whose offer window has already lapsed (a snapshot can
  // replay a stale OFFERED record whose workflow has long since moved on).
  const offer: DispatchView | null =
    online &&
    dispatch &&
    dispatch.status === DISPATCH_STATUS.OFFERED &&
    dispatch.offeredDriverId === driverId &&
    dispatch.orderId !== dismissed &&
    // Show the offer for its full server-stamped window (occurredAt + the effective backend offer
    // timeout), not a hardcoded client window. Older offers without offerExpiresAt fall back to status.
    (dispatch.offerExpiresAt ? Date.now() < Date.parse(dispatch.offerExpiresAt) : true)
      ? dispatch
      : null;
  const job: DispatchView | null =
    dispatch && (dispatch.status === DISPATCH_STATUS.DISPATCHED || dispatch.status === DISPATCH_STATUS.PICKED_UP) && dispatch.driverId === driverId
      ? dispatch
      : null;

  const { tenants } = useTenants();
  const me = tenants.find((t) => t.slug === tenantId);
  const center = me ? { lng: me.lng, lat: me.lat } : null;
  // Don't poll until the city center is known; pass a placeholder coord while watching is false.
  const { nearby } = useNearbyWatch(center ?? { lng: 0, lat: 0 }, online && center !== null);
  const self = nearby.find((d) => d.driverId === driverId) ?? null;
  const others = toNearbyRows(nearby, driverId);

  const onExpire = useCallback(() => { if (offer) setDismissed(offer.orderId); }, [offer]);

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="text-lg font-extrabold">
          flashbite <span className="text-muted-foreground font-semibold">driver</span>
        </div>
        <div className="flex items-center gap-3 text-sm font-semibold">
          <span className="text-muted-foreground">{driverId}</span>
          <OnlineToggle driverId={driverId} online={online} onChange={setOnline} />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6 space-y-6">
        {offer && (
          <OfferCard
            offer={offer}
            onAccept={() => { void acceptDispatch(offer.orderId, driverId); }}
            onReject={() => { setDismissed(offer.orderId); void rejectDispatch(offer.orderId, driverId); }}
            onExpire={onExpire}
          />
        )}
        {job && (
          <ActiveJobCard
            job={job}
            onPickup={() => { void pickupOrder(job.orderId, driverId); }}
            onDeliver={() => { void deliverOrder(job.orderId, driverId); }}
          />
        )}
        {!offer && !job && (
          <div className="rounded-xl border px-5 py-4 text-sm text-muted-foreground">
            {online
              ? "Online — waiting for an offer."
              : "You're offline. Go online to receive delivery offers."}
          </div>
        )}

        {online && !center && (
          <div className="rounded-xl border px-5 py-4 text-sm text-muted-foreground">Locating your city…</div>
        )}
        {online && center && (
          <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Nearby · 5km radius
              </div>
              <NearbyMap center={self ? { lng: self.lng, lat: self.lat } : center} self={self} nearby={others} />
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
