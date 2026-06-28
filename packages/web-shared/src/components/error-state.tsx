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
function renderAction(a: ErrorStateAction | undefined, variant: "outline" | "ghost"): ReactElement | null {
  if (!a) return null;
  return a.href ? (
    <Button asChild variant={variant} size="sm">
      <a href={a.href}>{a.label}</a>
    </Button>
  ) : (
    <Button variant={variant} size="sm" onClick={a.onClick}>
      {a.label}
    </Button>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
  action,
  secondaryAction,
  icon,
  variant = "block",
  className,
}: {
  title?: string;
  description?: string;
  action?: ErrorStateAction;
  /** Optional second action (e.g. "Sign out") rendered next to the primary, de-emphasised. */
  secondaryAction?: ErrorStateAction;
  icon?: ReactNode;
  variant?: "block" | "banner";
  className?: string;
}): ReactElement {
  const actionEl = renderAction(action, "outline");
  const secondaryActionEl = renderAction(secondaryAction, "ghost");
  const hasActions = actionEl !== null || secondaryActionEl !== null;

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
        {hasActions && <div className="ml-auto flex shrink-0 items-center gap-2">{actionEl}{secondaryActionEl}</div>}
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
        <h2 className="text-base font-bold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {hasActions && <div className="flex items-center gap-2">{actionEl}{secondaryActionEl}</div>}
    </div>
  );
}
