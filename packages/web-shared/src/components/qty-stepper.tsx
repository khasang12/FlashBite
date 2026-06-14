"use client";
import { Minus, Plus } from "lucide-react";
import { Button } from "./ui/button";

export function QtyStepper({ qty, onChange }: { qty: number; onChange: (q: number) => void }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border px-1">
      <Button size="icon" variant="ghost" className="h-7 w-7 rounded-full" onClick={() => onChange(qty - 1)} aria-label="decrease">
        <Minus className="h-4 w-4" />
      </Button>
      <span className="w-4 text-center text-sm font-semibold">{qty}</span>
      <Button size="icon" variant="ghost" className="h-7 w-7 rounded-full" onClick={() => onChange(qty + 1)} aria-label="increase">
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}
