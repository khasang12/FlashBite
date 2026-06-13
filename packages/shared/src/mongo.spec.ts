import { connectMongo } from "@flashbite/shared";

describe("connectMongo", () => {
  it("connects and returns a usable db (ping)", async () => {
    const { client, db } = await connectMongo();
    const res = await db.command({ ping: 1 });
    expect(res.ok).toBe(1);
    await client.close();
  });
});
