import type { Tenant } from "../store/tenant-store";

export interface MenuItem {
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  category: "pizza" | "burgers" | "sides" | "desserts" | "mains";
  imageUrl?: string;
  popular?: boolean;
}

const MENUS: Record<Tenant, MenuItem[]> = {
  berlin: [
    { sku: "pizza", name: "Pizza Margherita", description: "San Marzano, basil", priceCents: 1200, category: "pizza", popular: true },
    { sku: "burger", name: "Cheeseburger", description: "Aged cheddar", priceCents: 950, category: "burgers", popular: true },
    { sku: "fries", name: "Fries", description: "Sea salt", priceCents: 400, category: "sides", popular: true },
    { sku: "tiramisu", name: "Tiramisu", description: "Mascarpone, cocoa", priceCents: 600, category: "desserts" },
  ],
  tokyo: [
    { sku: "sushi", name: "Sushi Set", description: "Chef's selection", priceCents: 1800, category: "mains", popular: true },
    { sku: "ramen", name: "Tonkotsu Ramen", description: "Pork broth", priceCents: 1300, category: "mains", popular: true },
    { sku: "gyoza", name: "Gyoza (6)", description: "Pan-fried", priceCents: 700, category: "sides" },
    { sku: "mochi", name: "Mochi", description: "Red bean", priceCents: 500, category: "desserts" },
  ],
};

export function getMenu(tenant: Tenant): MenuItem[] {
  return MENUS[tenant];
}

/** Client-side "most chosen" until a backend popular endpoint exists. */
export function getPopular(tenant: Tenant): MenuItem[] {
  return MENUS[tenant].filter((i) => i.popular);
}
