import { CONTRACTS_PACKAGE } from "@flashbite/contracts";

describe("workspace tooling", () => {
  it("resolves the @flashbite/contracts alias", () => {
    expect(CONTRACTS_PACKAGE).toBe("@flashbite/contracts");
  });
});
