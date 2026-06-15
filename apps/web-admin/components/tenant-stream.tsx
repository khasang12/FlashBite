"use client";
import { useOrderStream, type OrderStreamEvent, type Tenant } from "@flashbite/web-shared";

/** Opens one live order SSE connection for a single tenant. Renders nothing. */
export function TenantStream({
  tenant, onEvent, onResync,
}: {
  tenant: Tenant;
  onEvent: (e: OrderStreamEvent) => void;
  onResync: () => void;
}) {
  useOrderStream(tenant, onEvent, onResync);
  return null;
}
