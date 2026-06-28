"use client";
import { Inbox } from "lucide-react";
import type { ReactNode, ReactElement } from "react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import type { ErrorStateAction } from "./error-state";

/**
 * Presentational "nothing here yet" block — the neutral sibling of ErrorState. Lighter on purpose:
 * no border / card background, so it sits cleanly inside a table cell or an existing card. The
 * consumer provides any surrounding chrome.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: string;
  action?: ErrorStateAction;
  icon?: ReactNode;
  className?: string;
}): ReactElement {
  const actionEl = action
    ? action.href
      ? (
        <Button asChild variant="outline" size="sm">
          <a href={action.href}>{action.label}</a>
        </Button>
      )
      : (
        <Button variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )
    : null;

  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      <span className="text-muted-foreground" aria-hidden>{icon ?? <Inbox className="h-8 w-8" />}</span>
      <p className="font-medium">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {actionEl && <div className="pt-1">{actionEl}</div>}
    </div>
  );
}
