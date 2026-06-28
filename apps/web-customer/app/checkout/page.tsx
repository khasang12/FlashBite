"use client";
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  useCartStore,
  placeOrder,
  Button,
  Input,
  Card,
  CardContent,
  EmptyState,
} from "@flashbite/web-shared";
import { Header } from "@/components/header";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export default function Checkout() {
  const router = useRouter();
  const items = useCartStore((s) => s.items);
  const total = useCartStore((s) => s.totalCents());
  const clear = useCartStore((s) => s.clear);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const orderId = crypto.randomUUID();
      await placeOrder({
        orderId,
        customerId: name.trim() || "guest",
        items: items.map((l) => ({ sku: l.sku, qty: l.qty, price: l.priceCents })),
        totalAmount: total,
      });
      clear();
      router.push(`/orders/${orderId}`);
    } catch {
      setError("Could not place your order. Please try again.");
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-lg px-6 py-6">
        <h1 className="mb-4 text-2xl font-extrabold">Checkout</h1>
        <Card>
          <CardContent className="p-4">
            {items.length === 0 ? (
              <EmptyState
                title="Your cart is empty"
                description="Add something from the menu to get started."
                action={{ label: "Browse menu", href: "/" }}
              />
            ) : (
              <>
                {items.map((l) => (
                  <div key={l.sku} className="mb-2 flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      {l.name} ×{l.qty}
                    </span>
                    <span>{euro(l.priceCents * l.qty)}</span>
                  </div>
                ))}
                <div className="mt-3 flex justify-between border-t pt-3 font-extrabold">
                  <span>Total</span>
                  <span>{euro(total)}</span>
                </div>
                <Input
                  aria-label="Your name"
                  className="mt-4"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                {error && (
                  <p className="mt-2 text-sm text-destructive">{error}</p>
                )}
                <Button
                  className="mt-4 w-full"
                  disabled={busy}
                  onClick={submit}
                >
                  {busy ? "Placing…" : `Place order · ${euro(total)}`}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
