"use client";
import { Button, DISPATCH_STATUS, dispatchStatusLabel, type DispatchView } from "@flashbite/web-shared";

export function ActiveJobCard({ job, onPickup, onDeliver }: {
  job: DispatchView;
  onPickup: () => void;
  onDeliver: () => void;
}) {
  return (
    <div className="rounded-xl border px-5 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-bold">{dispatchStatusLabel(job.status)}</div>
          <div className="text-xs text-muted-foreground">order {job.orderId}</div>
        </div>
        <div className="flex gap-2">
          {job.status === DISPATCH_STATUS.DISPATCHED && <Button onClick={onPickup}>Mark picked up</Button>}
          {job.status === DISPATCH_STATUS.PICKED_UP && <Button onClick={onDeliver}>Mark delivered</Button>}
        </div>
      </div>
    </div>
  );
}
