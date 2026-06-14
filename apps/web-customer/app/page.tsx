"use client";
import {
  useTenantStore,
  useCartStore,
  getMenu,
  getPopular,
  Button,
  Card,
  CardContent,
  Carousel,
  CarouselContent,
  CarouselItem,
} from "@flashbite/web-shared";
import Link from "next/link";
import { Header } from "@/components/header";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export default function Home() {
  const tenant = useTenantStore((s) => s.tenant);
  const add = useCartStore((s) => s.add);
  const total = useCartStore((s) => s.totalCents());
  const count = useCartStore((s) => s.count());
  const menu = getMenu(tenant);
  const popular = getPopular(tenant);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-5xl px-6 py-6">
        <input aria-label="Search" className="mb-5 w-full rounded-full bg-muted px-4 py-3 text-sm" placeholder="Search in FlashBite" />

        <h2 className="mb-3 text-xl font-extrabold">Most chosen 🔥</h2>
        <Carousel className="mb-8">
          <CarouselContent>
            {popular.map((item) => (
              <CarouselItem key={item.sku} className="basis-1/2 md:basis-1/4">
                <Card className="overflow-hidden">
                  <div className="h-24 bg-muted" />
                  <CardContent className="p-3">
                    <div className="font-bold">{item.name}</div>
                    <div className="text-xs text-muted-foreground">{euro(item.priceCents)}</div>
                  </CardContent>
                </Card>
              </CarouselItem>
            ))}
          </CarouselContent>
        </Carousel>

        <h2 className="mb-3 text-xl font-extrabold">All items</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {menu.map((item) => (
            <Card key={item.sku} className="overflow-hidden">
              <div className="h-28 bg-muted" />
              <CardContent className="p-3">
                <div className="font-bold">{item.name}</div>
                <div className="mb-2 text-sm text-muted-foreground">{item.description}</div>
                <div className="flex items-center justify-between">
                  <span className="font-bold">{euro(item.priceCents)}</span>
                  <Button
                    size="icon"
                    className="h-8 w-8 rounded-full"
                    onClick={() => add({ sku: item.sku, name: item.name, priceCents: item.priceCents })}
                    aria-label={`add ${item.name}`}
                  >+</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>

      {count > 0 && (
        <Link href="/checkout" className="fixed bottom-5 left-1/2 -translate-x-1/2">
          <Button size="lg" className="rounded-full px-8 shadow-lg">Place order · {euro(total)}</Button>
        </Link>
      )}
    </div>
  );
}
