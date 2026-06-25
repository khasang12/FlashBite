// (no Tenant import - menus are keyed by tenant slug as a plain string)

export interface MenuItem {
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  category: "pizza" | "burgers" | "sides" | "desserts" | "mains";
  imageUrl?: string;
  popular?: boolean;
}

const DEFAULT_TENANT = "berlin";

const MENUS: Record<string, MenuItem[]> = {
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

/** Demo storefront menu (not catalog data); unknown tenants fall back to the default menu. */
export function getMenu(tenant: string): MenuItem[] {
  return MENUS[tenant] ?? MENUS[DEFAULT_TENANT];
}

/** Client-side "most chosen" until a backend popular endpoint exists. */
export function getPopular(tenant: string): MenuItem[] {
  return getMenu(tenant).filter((i) => i.popular);
}
