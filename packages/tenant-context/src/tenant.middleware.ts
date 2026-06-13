import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { DEFAULT_TENANT_ID } from "@flashbite/shared";
import { runWithTenant } from "./tenant-context";

/**
 * Phase 1: hardcoded single tenant. Reads X-Tenant-ID if present, otherwise
 * falls back to DEFAULT_TENANT_ID. Phase 2 replaces this with verified-JWT
 * tenant resolution (master spec §3.3 / §3.5).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const tenantId = (req.headers["x-tenant-id"] as string) || DEFAULT_TENANT_ID;
    runWithTenant(tenantId, () => next());
  }
}
