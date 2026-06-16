import { runWithAuth } from "@flashbite/tenant-context";
import { currentTenant, scopedId, tenantFilter, scopedKey, scopedGeoKey } from "./tenant-scope";

const inBerlin = <T>(fn: () => T): T =>
  runWithAuth({ tenantId: "berlin", role: "customer", sub: "c-1" }, fn);

describe("tenant-scope (read-side scoping helper)", () => {
  it("currentTenant returns the JWT tenant", () => {
    expect(inBerlin(() => currentTenant())).toBe("berlin");
  });
  it("scopedId prefixes the current tenant (Mongo _id)", () => {
    expect(inBerlin(() => scopedId("o-1"))).toBe("berlin:o-1");
  });
  it("tenantFilter injects tenantId and merges extra fields", () => {
    expect(inBerlin(() => tenantFilter())).toEqual({ tenantId: "berlin" });
    expect(inBerlin(() => tenantFilter({ status: "PLACED" }))).toEqual({ tenantId: "berlin", status: "PLACED" });
  });
  it("scopedKey builds a hash-tagged tenant Redis key", () => {
    expect(inBerlin(() => scopedKey("order", "o-1", "view"))).toBe("tenant:{berlin}:order:o-1:view");
  });
  it("scopedGeoKey builds the tenant drivers geo key", () => {
    expect(inBerlin(() => scopedGeoKey())).toBe("tenant:{berlin}:drivers:geo");
  });
  it("throws when used outside an auth scope", () => {
    expect(() => scopedId("o-1")).toThrow();
  });
});
