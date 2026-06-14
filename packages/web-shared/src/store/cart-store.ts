"use client";
import { create } from "zustand";

export interface CartLine {
  sku: string;
  name: string;
  priceCents: number;
  qty: number;
}
type AddInput = Omit<CartLine, "qty">;

interface CartState {
  items: CartLine[];
  add: (item: AddInput) => void;
  setQty: (sku: string, qty: number) => void;
  remove: (sku: string) => void;
  clear: () => void;
  count: () => number;
  totalCents: () => number;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  add: (item) =>
    set((s) => {
      const existing = s.items.find((l) => l.sku === item.sku);
      if (existing) {
        return { items: s.items.map((l) => (l.sku === item.sku ? { ...l, qty: l.qty + 1 } : l)) };
      }
      return { items: [...s.items, { ...item, qty: 1 }] };
    }),
  setQty: (sku, qty) =>
    set((s) => ({
      items: qty <= 0 ? s.items.filter((l) => l.sku !== sku) : s.items.map((l) => (l.sku === sku ? { ...l, qty } : l)),
    })),
  remove: (sku) => set((s) => ({ items: s.items.filter((l) => l.sku !== sku) })),
  clear: () => set({ items: [] }),
  count: () => get().items.reduce((n, l) => n + l.qty, 0),
  totalCents: () => get().items.reduce((sum, l) => sum + l.priceCents * l.qty, 0),
}));
