"use client";
import { useEffect, useState } from "react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, Button, StatusPill,
  acceptOrder, declineOrder, ORDER_STATUS, type OrderView,
} from "@flashbite/web-shared";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export function OrderDetailSheet({
  order, onClose,
}: {
  order: OrderView | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [order?.orderId]);

  const act = async (fn: (id: string) => Promise<void>) => {
    if (!order) return;
    setBusy(true); setError(null);
    try {
      await fn(order.orderId);
      onClose(); // status flips when the saga's event arrives over SSE
    } catch {
      setError("Action failed. Please try again.");
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
            <div className="mt-3"><StatusPill status={order.status} /></div>
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
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
            {order.status === ORDER_STATUS.PLACED && (
              <div className="mt-6 flex gap-2">
                <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => act(declineOrder)}>
                  {busy ? "…" : "Decline"}
                </Button>
                <Button className="flex-1" disabled={busy} onClick={() => act(acceptOrder)}>
                  {busy ? "…" : "Accept"}
                </Button>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
