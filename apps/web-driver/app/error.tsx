"use client";
import { useEffect } from "react";
import { ErrorState, useAuthStore } from "@flashbite/web-shared";

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

  // Escape hatch for an auth-driven error (e.g. an expired session) that "Try again" can't clear:
  // drop the session and hard-navigate home so AuthGate boots fresh into the login screen.
  const signOut = () => {
    useAuthStore.getState().logout();
    window.location.assign("/");
  };

  return (
    <main className="flex min-h-[70vh] items-center justify-center px-6">
      <ErrorState
        title="Something went wrong"
        description="An unexpected error occurred. Please try again."
        action={{ label: "Try again", onClick: reset }}
        secondaryAction={{ label: "Sign out", onClick: signOut }}
        className="max-w-sm"
      />
    </main>
  );
}
