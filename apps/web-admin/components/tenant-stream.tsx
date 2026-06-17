"use client";
import { useOrderStream, type OrderStreamEvent } from "@flashbite/web-shared";

const ADMIN_STREAM_PATH = "/api/read/admin/orders/stream";

/** Opens ONE merged operator SSE stream covering all tenants. Renders nothing. */
export function AdminStream({
  onEvent,
  onResync,
}: {
  onEvent: (e: OrderStreamEvent) => void;
  onResync: () => void;
}) {
  useOrderStream(onEvent, onResync, ADMIN_STREAM_PATH);
  return null;
}
