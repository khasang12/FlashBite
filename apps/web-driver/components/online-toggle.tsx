"use client";
import { useState } from "react";
import { Button, goOnline, goOffline, toast } from "@flashbite/web-shared";

export function OnlineToggle({ driverId, online, onChange }: { driverId: string; online: boolean; onChange: (online: boolean) => void }) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const next = !online;
    try {
      if (next) await goOnline(driverId); else await goOffline(driverId);
      onChange(next);
      toast.success(next ? "You're online" : "You're offline");
    } catch {
      toast.error("Couldn't update your status.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 text-sm font-semibold">
      <span className={online ? "text-primary" : "text-muted-foreground"}>
        {online ? "Online" : "Offline"}
      </span>
      <Button variant={online ? "secondary" : "default"} onClick={toggle} disabled={busy} aria-pressed={online}>
        {online ? "Go offline" : "Go online"}
      </Button>
    </div>
  );
}
