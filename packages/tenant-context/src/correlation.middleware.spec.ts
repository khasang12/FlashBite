import { CorrelationMiddleware } from "./correlation.middleware";
import { getObsContext } from "@flashbite/shared";
import pino from "pino";

function res() {
  const handlers: Record<string, () => void> = {};
  return {
    setHeader: jest.fn(),
    statusCode: 200,
    on: (ev: string, cb: () => void) => { handlers[ev] = cb; },
    finish: () => handlers["finish"]?.(),
  } as any;
}

describe("CorrelationMiddleware", () => {
  const mw = new CorrelationMiddleware(pino({ enabled: false }));

  it("mints a correlationId and binds obsContext for the request scope", () => {
    const r = res();
    let seen: string | undefined;
    mw.use({ headers: { "x-correlation-id": "inbound-1" }, method: "GET", originalUrl: "/x" } as any, r, () => { seen = getObsContext()?.correlationId; });
    expect(seen).toBe("inbound-1");
  });
});
