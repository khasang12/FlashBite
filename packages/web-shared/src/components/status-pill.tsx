import { cn } from "../lib/utils";

const VARIANTS: Record<string, string> = {
  PLACED: "text-status-placed bg-status-placed-bg",
  ACCEPTED: "text-status-accepted bg-status-accepted-bg",
  CANCELLED: "text-status-cancelled bg-status-cancelled-bg",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full px-3 py-1 text-xs font-bold",
        VARIANTS[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}
