"use client";
import { useEffect, useState } from "react";
import { useAuthStore } from "../store/auth-store";
import { LoginForm, type DemoUser } from "./login-form";
import { Button } from "./ui/button";

export function AuthGate({
  children,
  demoUsers,
  requiredRole,
  title,
}: {
  children: React.ReactNode;
  demoUsers: DemoUser[];
  requiredRole?: string;
  title?: string;
}): React.ReactNode {
  const token = useAuthStore((s) => s.token);
  const claims = useAuthStore((s) => s.claims);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    void useAuthStore.persist.rehydrate();
    setHydrated(true);
  }, []);

  if (!hydrated) return null;
  if (!token) return <LoginForm demoUsers={demoUsers} onSubmit={login} title={title} />;
  if (requiredRole && claims?.role !== requiredRole) {
    return (
      <div className="mx-auto mt-24 max-w-sm space-y-3 p-6 text-center">
        <p className="text-sm">
          This view requires the <b>{requiredRole}</b> role. You are <b>{claims?.role}</b>.
        </p>
        <Button onClick={logout}>Log out</Button>
      </div>
    );
  }
  return (
    <>
      <div className="flex items-center justify-end gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
        <span>
          {claims?.role}@{claims?.tenantId}
        </span>
        <Button variant="outline" size="sm" onClick={logout}>
          Log out
        </Button>
      </div>
      {children}
    </>
  );
}
