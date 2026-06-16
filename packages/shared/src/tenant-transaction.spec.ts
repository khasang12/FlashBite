import { withTenantTransaction } from "./tenant-transaction";

describe("withTenantTransaction", () => {
  it("runs set_config('app.tenant_id', tenantId, true) as the FIRST statement, then the body", async () => {
    const calls: string[] = [];
    const fakeTx = {
      // Prisma's tagged-template $executeRaw: (strings, ...values)
      $executeRaw: (_strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(`set_config:${String(values[0])}`);
        return Promise.resolve(1);
      },
    };
    const fakePrisma = {
      $transaction: (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
    };

    const result = await withTenantTransaction(fakePrisma as never, "berlin", async (tx) => {
      calls.push("body");
      // confirm the same tx is passed through
      expect(tx).toBe(fakeTx);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toEqual(["set_config:berlin", "body"]); // set_config strictly first
  });

  it("propagates the tenantId into set_config", async () => {
    const seen: unknown[] = [];
    const fakeTx = {
      $executeRaw: (_s: TemplateStringsArray, ...v: unknown[]) => {
        seen.push(v[0]);
        return Promise.resolve(1);
      },
    };
    const fakePrisma = { $transaction: (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx) };
    await withTenantTransaction(fakePrisma as never, "tokyo", async () => undefined);
    expect(seen).toEqual(["tokyo"]);
  });
});
