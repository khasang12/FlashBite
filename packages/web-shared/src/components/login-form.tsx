"use client";
import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface DemoUser {
  label: string;
  email: string;
}

const DEMO_PASSWORD = "devpassword";

export function LoginForm({
  demoUsers,
  onSubmit,
  title = "Sign in",
}: {
  demoUsers: DemoUser[];
  onSubmit: (email: string, password: string) => Promise<void>;
  title?: string;
}): React.ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(email, password);
    } catch {
      setError("Invalid email or password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-24 w-full max-w-sm space-y-4 p-6">
      <h1 className="text-xl font-semibold">{title}</h1>
      <form onSubmit={submit} className="space-y-3">
        <Input
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="email"
        />
        <Input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="password"
        />
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          Demo users (password: {DEMO_PASSWORD})
        </p>
        <div className="flex flex-wrap gap-2">
          {demoUsers.map((u) => (
            <Button
              key={u.email}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setEmail(u.email);
                setPassword(DEMO_PASSWORD);
              }}
            >
              {u.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
