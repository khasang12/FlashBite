"use client";
import { use, useEffect, useState } from "react";
import {
  getOrder,
  fetchOrderPayment,
  confirmPayment,
  paymentStatusLabel,
  cancelReasonLabel,
  getOrderDispatch,
  deliveryStatusLabel,
  DISPATCH_STATUS,
  StatusPill,
  Card,
  CardContent,
  Skeleton,
  Button,
  AuthGate,
  ORDER_STATUS,
  getOrderDriverLocation,
  useTenants,
  useAuthStore,
  type OrderView,
  type DispatchView,
  type Tenant,
} from "@flashbite/web-shared";
import { Header } from "@/components/header";
import { DriverMap } from "@/components/driver-map";

const CUSTOMER_DEMOS = [
  { label: "Berlin customer", email: "customer@berlin.test" },
  { label: "Tokyo customer", email: "customer@tokyo.test" },
];

const TERMINAL = [ORDER_STATUS.ACCEPTED, ORDER_STATUS.CANCELLED] as string[];
const POLL_MS = 2000;
// Stop polling after this many *visible* attempts (~5.5 min) so a PLACED order
// that never resolves can't poll forever, while still outlasting the saga SLA
// timer (default SAGA_SLA_SECONDS=300) so the FE catches the auto-cancel.
const MAX_ATTEMPTS = 170;

export default function OrderTracking(props: {
  params: Promise<{ orderId: string }>;
}) {
  return (
    <AuthGate demoUsers={CUSTOMER_DEMOS} requiredRole="customer" title="FlashBite — Customer">
      <OrderTrackingContent {...props} />
    </AuthGate>
  );
}

function OrderTrackingContent({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = use(params);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [stopped, setStopped] = useState(false);
  const [round, setRound] = useState(0);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [dispatch, setDispatch] = useState<DispatchView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const tenantId = (useAuthStore((s) => s.claims?.tenantId) ?? "berlin") as Tenant;
  const { tenants } = useTenants();
  const me = tenants.find((t) => t.slug === tenantId);
  const mapCenter = me ? { lng: me.lng, lat: me.lat } : null;
  const [driverLocation, setDriverLocation] = useState<{ lng: number; lat: number } | null>(null);

  useEffect(() => {
    setStopped(false);
    let active = true;
    let tries = 0;
    let misses = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      // Don't hit the network while the tab is backgrounded — just re-check later.
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      const o = await getOrder(orderId).catch(() => null);
      if (!active) return;
      if (o) {
        setOrder(o);
        setWaiting(false);
        const p = await fetchOrderPayment(orderId).catch(() => null);
        if (active && p) setPaymentStatus(p.status);
        let nextDispatch = dispatch;
        if (o.status === ORDER_STATUS.ACCEPTED) {
          const d = await getOrderDispatch(orderId).catch(() => null);
          if (active && d && "status" in d && d.status !== null) {
            nextDispatch = d as DispatchView;
            setDispatch(nextDispatch);
          }
        }
        const enRoute =
          nextDispatch?.status === DISPATCH_STATUS.DISPATCHED || nextDispatch?.status === DISPATCH_STATUS.PICKED_UP;
        if (enRoute) {
          // A swallowed fetch error -> undefined -> keep the last known position (no flicker).
          // A legitimate server null (no ping yet) still clears the marker.
          const loc = await getOrderDriverLocation(orderId).catch(() => undefined);
          if (active && loc !== undefined) setDriverLocation(loc);
        } else if (active) {
          setDriverLocation(null);
        }
        // Stop on cancellation, or once an accepted order's delivery has finished.
        const deliveryTerminal =
          nextDispatch?.status === DISPATCH_STATUS.DELIVERED || nextDispatch?.status === DISPATCH_STATUS.FAILED;
        if (o.status === ORDER_STATUS.CANCELLED) return;
        if (o.status === ORDER_STATUS.ACCEPTED && deliveryTerminal) return;
      } else {
        misses += 1;
        if (misses > 5) setWaiting(false);
      }
      tries += 1;
      if (tries >= MAX_ATTEMPTS) {
        setStopped(true); // give up the live poll; offer a manual refresh
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };

    tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [orderId, round]);

  const isTerminal = order ? TERMINAL.includes(order.status) : false;
  const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;
  const awaitingConfirm = order?.status === ORDER_STATUS.PLACED && paymentStatus === null;

  const onConfirm = async () => {
    if (!order) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmPayment(order.orderId);
      // saga authorizes shortly; the existing poll surfaces Payment: Authorized
    } catch {
      setConfirmError("Couldn't confirm payment. Please try again.");
      setConfirming(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-lg px-6 py-6">
        <h1 className="mb-1 text-2xl font-extrabold">Your order</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          #{orderId.slice(0, 8)}…
        </p>
        <Card>
          <CardContent className="p-5">
            {!order && waiting && <Skeleton className="h-6 w-32" />}
            {!order && !waiting && (
              <p className="text-muted-foreground">
                Still processing — hang tight.
              </p>
            )}
            {order && (
              <div className="space-y-3" aria-live="polite">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Status</span>
                  <StatusPill status={order.status} />
                </div>
                {awaitingConfirm && (
                  <div className="space-y-2">
                    <Button className="w-full" disabled={confirming} onClick={onConfirm}>
                      {confirming ? "Confirming…" : `Confirm payment ${euro(order.totalAmount)}`}
                    </Button>
                    {confirmError && <p className="text-sm text-destructive">{confirmError}</p>}
                  </div>
                )}
                {paymentStatusLabel(paymentStatus) && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Payment</span>
                    <span className="font-semibold">{paymentStatusLabel(paymentStatus)}</span>
                  </div>
                )}
                {order.status === ORDER_STATUS.ACCEPTED && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Delivery</span>
                    <span className="font-semibold">
                      {dispatch ? deliveryStatusLabel(dispatch.status) : "Preparing…"}
                    </span>
                  </div>
                )}
                {(dispatch?.status === DISPATCH_STATUS.DISPATCHED || dispatch?.status === DISPATCH_STATUS.PICKED_UP) && (
                  <div className="space-y-1">
                    <div className="text-sm text-muted-foreground">Driver en route</div>
                    {mapCenter && <DriverMap center={mapCenter} driver={driverLocation} />}
                  </div>
                )}
                {order.status === ORDER_STATUS.CANCELLED && cancelReasonLabel(order.cancelReason) && (
                  <p className="text-sm text-destructive">{cancelReasonLabel(order.cancelReason)}</p>
                )}
                {!isTerminal && !stopped && !awaitingConfirm && (
                  <p className="text-sm text-muted-foreground">
                    Waiting for the merchant… (saga SLA timer running)
                  </p>
                )}
              </div>
            )}
            {stopped && !isTerminal && (
              <div className="mt-4 space-y-2">
                <p className="text-sm text-muted-foreground">
                  Still waiting on the merchant. We paused live updates.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setRound((r) => r + 1)}
                >
                  Check again
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
