import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAuthStore } from "../store/auth-store";
import { useTenants } from "./use-tenants";

const fetchMock = vi.fn();
beforeEach(() => {
  useAuthStore.setState({ token: "test-token", claims: { sub: "op", tenantId: "platform", role: "operator" } });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("useTenants", () => {
  // One test: the module-level cache is fresh per test FILE, so this single case
  // exercises both "returns the catalog" and "fetch is deduped across consumers".
  it("fetches the catalog once and shares it across consumers", async () => {
    const rows = [{ slug: "berlin", displayName: "Berlin", lng: 13.405, lat: 52.52, status: "active" }];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
    const a = renderHook(() => useTenants());
    const b = renderHook(() => useTenants());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));
    expect(a.result.current.tenants).toHaveLength(1);
    expect(b.result.current.tenants[0].slug).toBe("berlin");
    const tenantCalls = fetchMock.mock.calls.filter((c) => c[0] === "/api/read/tenants");
    expect(tenantCalls).toHaveLength(1);
  });
});
