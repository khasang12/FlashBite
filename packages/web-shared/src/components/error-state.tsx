"use client";
import { AlertTriangle } from "lucide-react";
import type { ReactNode, ReactElement } from "react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export interface ErrorStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

/**
 * Presentational failure block. Does not impose full-screen centering — the consumer positions it
 * (route boundaries center it; admin renders the `banner` variant inline above the grid; merchant
 * renders the `block` variant in the content area).
 */
export function ErrorState({
  title = "Something went wrong",
  description,
  action,
  icon,
  variant = "block",
  className,
}: {
  title?: string;
  description?: string;
  action?: ErrorStateAction;
  icon?: ReactNode;
  variant?: "block" | "banner";
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

  if (variant === "banner") {
    return (
      <div
        role="alert"
        className={cn(
          "flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive",
          className,
        )}
      >
        <span aria-hidden>{icon ?? <AlertTriangle className="h-4 w-4 shrink-0" />}</span>
        <div className="min-w-0">
          <span className="font-semibold">{title}</span>
          {description && <span className="text-destructive/80"> — {description}</span>}
        </div>
        {actionEl && <div className="ml-auto shrink-0">{actionEl}</div>}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-10 text-center",
        className,
      )}
    >
      <span className="text-muted-foreground" aria-hidden>
        {icon ?? <AlertTriangle className="h-8 w-8" />}
      </span>
      <div className="space-y-1">
        <p className="text-base font-bold">{title}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actionEl}
    </div>
  );
}
