import { CanActivate, ExecutionContext, ForbiddenException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { TenantCatalogService } from "@flashbite/shared";
import { getAuthContext, AuthContextError } from "./auth-context";

// Mirrors ROLES.OPERATOR from @flashbite/contracts; hardcoded to avoid adding a contracts dep
// to this package. The operator principal is cross-tenant (tenantId "platform"), so it bypasses
// the single-tenant active check.
const OPERATOR_ROLE = "operator";

/** Per-request TCS check: the JWT tenantId must be a real, active catalog tenant. */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly catalog: TenantCatalogService) {}

  async canActivate(_ctx: ExecutionContext): Promise<boolean> {
    let auth;
    try {
      auth = getAuthContext();
    } catch (e) {
      if (e instanceof AuthContextError) return true; // no context (health/pre-auth) — not our job
      throw e;
    }
    if (auth.role === OPERATOR_ROLE) return true;
    let active: boolean;
    try {
      active = await this.catalog.isActive(auth.tenantId);
    } catch {
      throw new ServiceUnavailableException("tenant catalog unavailable");
    }
    if (active) return true;
    throw new ForbiddenException("Unknown or inactive tenant");
  }
}
