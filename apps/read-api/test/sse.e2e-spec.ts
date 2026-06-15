import "reflect-metadata";
import http from "node:http";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { OrderStreamService } from "../src/sse/order-stream.service";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";

describe("read-api merchant SSE (e2e)", () => {
  let app: INestApplication;
  let stream: OrderStreamService;
  let port: number;
  let auth: TestAuth;
  let berlinToken: string;

  beforeAll(async () => {
    auth = await createTestAuth();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    stream = app.get(OrderStreamService);
    berlinToken = await auth.mint({ tenantId: "berlin", role: "merchant", sub: "m-1" });
  });
  afterAll(async () => { await app.close(); });

  it("streams a published order event to the tenant's SSE client", async () => {
    const received = await new Promise<string>((resolve, reject) => {
      let guardTimer: ReturnType<typeof setTimeout>;
      const done = (result: string | Error) => {
        clearTimeout(guardTimer);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const req = http.get(
        {
          host: "127.0.0.1",
          port,
          path: "/merchant/orders/stream",
          headers: { "Authorization": `Bearer ${berlinToken}` },
        },
        (res) => {
          res.setEncoding("utf8");
          let buf = "";
          res.on("data", (chunk: string) => {
            buf += chunk;
            if (buf.includes("o-sse-1")) {
              req.destroy();
              done(buf);
            }
          });
          res.on("error", (e) => done(e));
        },
      );
      req.on("error", (e) => {
        if (!/aborted|hang up|ECONNRESET|socket/i.test(String(e))) done(e);
      });
      setTimeout(() => stream.publish("berlin", { orderId: "o-sse-1", eventType: "OrderPlaced", status: "PLACED" }), 400);
      guardTimer = setTimeout(() => done(new Error("no SSE event received")), 9000);
    });
    expect(received).toContain("o-sse-1");
  }, 15000);
});
