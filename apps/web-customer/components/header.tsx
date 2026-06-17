"use client";
import Link from "next/link";
import { useCartStore, Button } from "@flashbite/web-shared";

export function Header() {
  const count = useCartStore((s) => s.count());

  return (
    <header className="flex items-center justify-between border-b px-6 py-4">
      <Link href="/" className="text-lg font-extrabold tracking-tight">flashbite</Link>
      <div className="flex items-center gap-4">
        <Link href="/checkout"><Button size="sm">Cart ({count})</Button></Link>
      </div>
    </header>
  );
}
