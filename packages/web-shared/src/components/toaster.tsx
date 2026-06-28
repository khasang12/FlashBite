"use client";
import type { ReactElement } from "react";
import { Toaster as SonnerToaster } from "sonner";

/** App-wide toast host. Mounted once per app layout; renders nothing until a toast fires. */
export function Toaster(): ReactElement {
  return <SonnerToaster richColors position="bottom-right" theme="light" />;
}
