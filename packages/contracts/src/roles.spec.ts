import { ROLES } from "./index";

describe("ROLES", () => {
  it("defines the canonical role values", () => {
    expect(ROLES).toEqual({
      CUSTOMER: "customer",
      MERCHANT: "merchant",
      DRIVER: "driver",
      ADMIN: "admin",
      OPERATOR: "operator",
    });
  });
});
