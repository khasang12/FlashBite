import { Tenant, GeoPoint, TenantView, NearbyDriver } from "./index";

describe("contracts geo types", () => {
  it("Tenant is a string alias (catalog-backed; no hardcoded list)", () => {
    const t: Tenant = "berlin";
    expect(typeof t).toBe("string");
  });
  it("GeoPoint has lng and lat", () => {
    const p: GeoPoint = { lng: 13.405, lat: 52.52 };
    expect(p.lng).toBe(13.405);
    expect(p.lat).toBe(52.52);
  });
  it("TenantView has the expected shape", () => {
    const v: TenantView = { slug: "berlin", displayName: "Berlin", lng: 13.405, lat: 52.52, status: "active" };
    expect(v.slug).toBe("berlin");
    expect(v.status).toBe("active");
  });
  it("NearbyDriver has the expected shape", () => {
    const d: NearbyDriver = { driverId: "drv-1", distanceKm: 1.2, lng: 13.405, lat: 52.52 };
    expect(d.driverId).toBe("drv-1");
    expect(d.distanceKm).toBeGreaterThan(0);
  });
});
