import { PrismaService } from "./prisma.service";

describe("PrismaService", () => {
  it("constructs without a url (defaults to DATABASE_URL env)", () => {
    const svc = new PrismaService();
    expect(svc).toBeInstanceOf(PrismaService);
  });

  it("accepts an explicit connection url", () => {
    const svc = new PrismaService("postgresql://flashbite_app:pw@localhost:5434/flashbite_write");
    expect(svc).toBeInstanceOf(PrismaService);
  });
});
