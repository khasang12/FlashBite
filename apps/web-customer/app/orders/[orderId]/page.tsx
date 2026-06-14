"use client";
import { use, useEffect, useState } from "react";
import {
  getOrder,
  useTenantStore,
  StatusPill,
  Card,
  CardContent,
  Skeleton,
  ORDER_STATUS,
  type OrderView,
} from "@flashbite/web-shared";
import { Header } from "@/components/header";

const TERMINAL = [ORDER_STATUS.ACCEPTED, ORDER_STATUS.CANCELLED] as string[];

export default function OrderTracking({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = use(params);
  const tenant = useTenantStore((s) => s.tenant);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [waiting, setWaiting] = useState(true);

  useEffect(() => {
    let active = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const o = await getOrder(tenant, orderId).catch(() => null);
      if (!active) return;
      if (o) {
        setOrder(o);
        setWaiting(false);
        if (TERMINAL.includes(o.status)) return;
      } else {
        tries += 1;
        if (tries > 5) setWaiting(false);
      }
      timer = setTimeout(tick, 2000);
    };
    tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [tenant, orderId]);

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
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Status</span>
                  <StatusPill status={order.status} />
                </div>
                {!TERMINAL.includes(order.status) && (
                  <p className="text-sm text-muted-foreground">
                    Waiting for the merchant… (saga SLA timer running)
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
