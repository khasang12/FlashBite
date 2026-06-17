export const TENANTS = ["berlin", "tokyo"] as const;
export type Tenant = (typeof TENANTS)[number];
