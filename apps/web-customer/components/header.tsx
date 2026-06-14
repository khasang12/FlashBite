"use client";
import { useEffect } from "react";
import Link from "next/link";
import {
  useCartStore,
  useTenantStore,
  TENANTS,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@flashbite/web-shared";

export function Header() {
  const tenant = useTenantStore((s) => s.tenant);
  const setTenant = useTenantStore((s) => s.setTenant);
  const count = useCartStore((s) => s.count());

  useEffect(() => {
    useTenantStore.persist.rehydrate();
  }, []);

  return (
    <header className="flex items-center justify-between border-b px-6 py-4">
      <Link href="/" className="text-lg font-extrabold tracking-tight">flashbite</Link>
      <div className="flex items-center gap-4">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 text-sm font-semibold">
            <span className="h-2 w-2 rounded-full bg-primary" /> {tenant} ▾
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {TENANTS.map((t) => (
              <DropdownMenuItem
                key={t}
                onClick={() => {
                  setTenant(t);
                  useCartStore.getState().clear();
                }}
              >
                {t}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Link href="/checkout"><Button size="sm">Cart ({count})</Button></Link>
      </div>
    </header>
  );
}
