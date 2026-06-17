"use client";
import { use, useEffect, useState } from "react";
import {
  getOrder,
  StatusPill,
  Card,
  CardContent,
  Skeleton,
  Button,
  ORDER_STATUS,
  type OrderView,
} from "@flashbite/web-shared";
import { Header } from "@/components/header";

const TERMINAL = [ORDER_STATUS.ACCEPTED, ORDER_STATUS.CANCELLED] as string[];
const POLL_MS = 2000;
// Stop polling after this many *visible* attempts (~5.5 min) so a PLACED order
// that never resolves can't poll forever, while still outlasting the saga SLA
// timer (default SAGA_SLA_SECONDS=300) so the FE catches the auto-cancel.
const MAX_ATTEMPTS = 170;

export default function OrderTracking({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = use(params);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [stopped, setStopped] = useState(false);
  const [round, setRound] = useState(0);

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
        if (TERMINAL.includes(o.status)) return; // resolved — stop polling
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
                {!isTerminal && !stopped && (
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
