"use client";
import { useEffect } from "react";
import { ErrorState } from "@flashbite/web-shared";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Next.js convention: surface boundary errors to the console.
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-[70vh] items-center justify-center px-6">
      <ErrorState
        title="Something went wrong"
        description="An unexpected error occurred. Please try again."
        action={{ label: "Try again", onClick: reset }}
        className="max-w-sm"
      />
    </main>
  );
}
