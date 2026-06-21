"use client";
import { useCallback, useEffect, useState } from "react";
import {
  AuthGate, useAuthStore,
  type Tenant, type DispatchView,
  CITY_CENTERS, toNearbyRows,
  DISPATCH_STATUS, DISPATCH_OFFER_TIMEOUT_SECONDS,
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
  // An offer for this driver that they haven't dismissed (rejected/expired) locally and whose
  // offer window hasn't already lapsed — a snapshot can replay a stale OFFERED record whose
  // workflow has long since moved on, which we must not present as a live offer.
  const offer: DispatchView | null =
    dispatch &&
    dispatch.status === DISPATCH_STATUS.OFFERED &&
    dispatch.offeredDriverId === driverId &&
    dispatch.orderId !== dismissed &&
    Date.now() - Date.parse(dispatch.updatedAt) < DISPATCH_OFFER_TIMEOUT_SECONDS * 1000
      ? dispatch
      : null;
  const job: DispatchView | null =
    dispatch && (dispatch.status === DISPATCH_STATUS.DISPATCHED || dispatch.status === DISPATCH_STATUS.PICKED_UP) && dispatch.driverId === driverId
      ? dispatch
      : null;

  const center = CITY_CENTERS[tenantId];
  const { nearby } = useNearbyWatch(center, online);
  const self = nearby.find((d) => d.driverId === driverId) ?? null;
  const others = toNearbyRows(nearby, driverId);
  const mapCenter = self ? { lng: self.lng, lat: self.lat } : center;

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

        {online && (
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
