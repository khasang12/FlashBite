import { SignJWT } from "jose";
import { createTestAuth } from "./testing";

describe("TokenVerifier", () => {
  it("verifies a well-formed token and returns the auth context", async () => {
    const { verifier, mint } = await createTestAuth();
    const token = await mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
    const ctx = await verifier.verify(token);
    expect(ctx).toEqual({ tenantId: "berlin", role: "customer", sub: "c-1" });
  });

  it("rejects a token with the wrong issuer", async () => {
    const { verifier, signWith, kid } = await createTestAuth();
    const bad = await new SignJWT({ tenantId: "berlin", role: "customer" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject("c-1")
      .setIssuer("someone-else")
      .setAudience("flashbite")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(signWith);
    await expect(verifier.verify(bad)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { verifier, signWith, kid } = await createTestAuth();
    const expired = await new SignJWT({ tenantId: "berlin", role: "customer" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject("c-1")
      .setIssuer("flashbite-identity")
      .setAudience("flashbite")
      .setIssuedAt(0)
      .setExpirationTime(1)
      .sign(signWith);
    await expect(verifier.verify(expired)).rejects.toThrow();
  });

  it("rejects a tampered token", async () => {
    const { verifier, mint } = await createTestAuth();
    const token = await mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
    const tampered = token.slice(0, -3) + "AAA";
    await expect(verifier.verify(tampered)).rejects.toThrow();
  });

  it("rejects a token missing required claims", async () => {
    const { verifier, signWith, kid } = await createTestAuth();
    const noTenant = await new SignJWT({ role: "customer" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject("c-1")
      .setIssuer("flashbite-identity")
      .setAudience("flashbite")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(signWith);
    await expect(verifier.verify(noTenant)).rejects.toThrow();
  });
});
