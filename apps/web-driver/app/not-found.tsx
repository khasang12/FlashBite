import { ErrorState } from "@flashbite/web-shared";

export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-6">
      <ErrorState
        title="Page not found"
        description="The page you're looking for doesn't exist."
        action={{ label: "Back to home", href: "/" }}
        className="max-w-sm"
      />
    </main>
  );
}
