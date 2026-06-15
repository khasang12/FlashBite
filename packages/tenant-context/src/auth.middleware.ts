import { Injectable, NestMiddleware, UnauthorizedException } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { runWithAuth } from "./auth-context";
import { TokenVerifier } from "./token-verifier";

/**
 * Phase 2: tenant + role come ONLY from a verified RS256 JWT. No X-Tenant-ID
 * fallback. Missing/invalid token -> 401. Establishes the auth context for the
 * request so guards/controllers/services read it via getTenantId()/getRole().
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly verifier: TokenVerifier) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }
    let ctx;
    try {
      ctx = await this.verifier.verify(token);
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
    runWithAuth(ctx, () => next());
  }
}
