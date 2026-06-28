"use client";
import { useEffect, useRef, useState } from "react";
import { Button, DISPATCH_OFFER_TIMEOUT_SECONDS, type DispatchView } from "@flashbite/web-shared";

// Count down to the server-stamped offerExpiresAt (occurredAt + the effective backend offer
// timeout). Fall back to the legacy fixed window only for old offers that predate offerExpiresAt.
function secondsLeft(offer: DispatchView): number {
  if (offer.offerExpiresAt) {
    return Math.max(0, Math.ceil((Date.parse(offer.offerExpiresAt) - Date.now()) / 1000));
  }
  const elapsed = (Date.now() - Date.parse(offer.updatedAt)) / 1000;
  return Math.max(0, Math.ceil(DISPATCH_OFFER_TIMEOUT_SECONDS - elapsed));
}

export function OfferCard({ offer, onAccept, onReject, onExpire }: {
  offer: DispatchView;
  onAccept: () => void;
  onReject: () => void;
  onExpire: () => void;
}) {
  const [left, setLeft] = useState(() => secondsLeft(offer));
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    setLeft(secondsLeft(offer));
    const t = setInterval(() => {
      const s = secondsLeft(offer);
      setLeft(s);
      if (s <= 0) {
        clearInterval(t);
        onExpireRef.current();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [offer.offerExpiresAt, offer.updatedAt, offer.orderId]);

  return (
    <div className="rounded-xl border border-primary/40 bg-primary/5 px-5 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-bold">New delivery offer</div>
          <div className="text-xs text-muted-foreground">order {offer.orderId} · expires in {left}s</div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onReject}>Decline</Button>
          <Button onClick={onAccept}>Accept</Button>
        </div>
      </div>
    </div>
  );
}
