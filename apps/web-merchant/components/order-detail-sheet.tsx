"use client";
import { useEffect, useState } from "react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, Button, StatusPill,
  acceptOrder, declineOrder, cancelReasonLabel, fetchOrderPayment, ORDER_STATUS,
  deliveryStatusLabel, getOrderDispatch, toast,
  type OrderView, type DispatchView,
} from "@flashbite/web-shared";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export function OrderDetailSheet({
  order, dispatch, onClose,
}: {
  order: OrderView | null;
  dispatch: DispatchView | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);

  useEffect(() => {
    setBusy(false);
    setPaymentStatus(null);
    if (!order) return;
    let active = true;
    fetchOrderPayment(order.orderId)
      .then((p) => { if (active) setPaymentStatus(p.status); })
      .catch(() => { if (active) setPaymentStatus(null); });
    return () => { active = false; };
  }, [order?.orderId]);

  const [dispatchFallback, setDispatchFallback] = useState<DispatchView | null>(null);
  useEffect(() => {
    setDispatchFallback(null);
    if (!order) return;
    let active = true;
    getOrderDispatch(order.orderId)
      .then((d) => { if (active && "status" in d && d.status !== null) setDispatchFallback(d as DispatchView); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [order?.orderId]);
  const delivery = dispatch ?? dispatchFallback;

  const act = async (fn: (id: string) => Promise<void>, successMsg: string) => {
    if (!order) return;
    setBusy(true);
    try {
      await fn(order.orderId);
      onClose(); // status flips when the saga's event arrives over SSE
      toast.success(successMsg);
    } catch {
      toast.error("Couldn't update the order.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={order !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent>
        {order && (
          <>
            <SheetHeader>
              <SheetTitle>Order #{order.orderId.slice(0, 8)}</SheetTitle>
              <SheetDescription>Order details and merchant actions.</SheetDescription>
            </SheetHeader>
            <div className="mt-3 flex items-center gap-2">
              <StatusPill status={order.status} />
              {order.status === ORDER_STATUS.CANCELLED && cancelReasonLabel(order.cancelReason) && (
                <span className="text-xs text-muted-foreground">{cancelReasonLabel(order.cancelReason)}</span>
              )}
            </div>
            <div className="mt-4 text-sm text-muted-foreground">Customer</div>
            <div className="font-semibold">{order.customerId}</div>
            <div className="mt-4 text-sm text-muted-foreground">Items</div>
            <div className="mt-1 space-y-1">
              {(order.items ?? []).map((i) => (
                <div key={i.sku} className="flex justify-between text-sm">
                  <span>{i.sku} ×{i.qty}</span><span>{euro(i.price * i.qty)}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-between border-t pt-3 font-extrabold">
              <span>Total</span><span>{euro(order.totalAmount)}</span>
            </div>
            {order.status === ORDER_STATUS.ACCEPTED && (
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Delivery</span>
                <span className="font-semibold">{delivery ? deliveryStatusLabel(delivery.status) : "Preparing…"}</span>
              </div>
            )}
            {order.status === ORDER_STATUS.PLACED && (
              paymentStatus === "AUTHORIZED" ? (
                <div className="mt-6 flex gap-2">
                  <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => act(declineOrder, "Order declined")}>
                    {busy ? "…" : "Decline"}
                  </Button>
                  <Button className="flex-1" disabled={busy} onClick={() => act(acceptOrder, "Order accepted")}>
                    {busy ? "…" : "Accept"}
                  </Button>
                </div>
              ) : (
                <p className="mt-6 text-sm text-muted-foreground">Awaiting customer payment…</p>
              )
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
