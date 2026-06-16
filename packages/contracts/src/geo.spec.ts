import { TENANTS, CITY_CENTERS } from "./index";

describe("tenants + city centers", () => {
  it("lists the known tenants", () => {
    expect(TENANTS).toEqual(["berlin", "tokyo"]);
  });
  it("has a city center per tenant", () => {
    for (const t of TENANTS) {
      expect(CITY_CENTERS[t]).toEqual(expect.objectContaining({ lng: expect.any(Number), lat: expect.any(Number) }));
    }
    expect(CITY_CENTERS.berlin).toEqual({ lng: 13.405, lat: 52.52 });
    expect(CITY_CENTERS.tokyo).toEqual({ lng: 139.7, lat: 35.68 });
  });
});
