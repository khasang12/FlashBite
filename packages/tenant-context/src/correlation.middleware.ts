import { Injectable, NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import type { Logger } from "pino";
import { runWithObsContext, newCorrelationId, type ObsContext } from "@flashbite/shared";

/**
 * Mints or ingests a correlationId, binds the obsContext for the request, echoes the id on the
 * response, and logs one completion line. Register BEFORE AuthMiddleware so even 401s/health are
 * correlated; AuthMiddleware later fills obs.tenantId once the JWT is verified.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(private readonly log: Logger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers["x-correlation-id"];
    const correlationId = (Array.isArray(inbound) ? inbound[0] : inbound) || newCorrelationId();
    const obs: ObsContext = { correlationId };
    res.setHeader("x-correlation-id", correlationId);
    const start = Date.now();
    res.on("finish", () => {
      this.log.info({ method: req.method, path: req.originalUrl, statusCode: res.statusCode, durationMs: Date.now() - start }, "request");
    });
    runWithObsContext(obs, () => next());
  }
}
