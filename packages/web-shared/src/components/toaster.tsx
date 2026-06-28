"use client";
import { Toaster as SonnerToaster } from "sonner";

/** App-wide toast host. Mounted once per app layout; renders nothing until a toast fires. */
export function Toaster() {
  return <SonnerToaster richColors position="bottom-right" theme="light" />;
}
