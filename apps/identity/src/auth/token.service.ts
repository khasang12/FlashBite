import { Injectable, Optional } from "@nestjs/common";
import { SignJWT } from "jose";
import { loadConfig, type AppConfig } from "@flashbite/shared";
import { KeyService } from "./key.service";

export interface AccessClaims {
  sub: string;
  tenantId: string;
  role: string;
}

@Injectable()
export class TokenService {
  private readonly cfg: AppConfig;
  constructor(private readonly keys: KeyService, @Optional() cfg?: AppConfig) {
    this.cfg = cfg ?? loadConfig();
  }

  ttlSeconds(): number {
    return this.cfg.jwtAccessTtl;
  }

  async sign(claims: AccessClaims): Promise<string> {
    const { key, kid, alg } = this.keys.signingKey();
    return new SignJWT({ tenantId: claims.tenantId, role: claims.role })
      .setProtectedHeader({ alg, kid })
      .setSubject(claims.sub)
      .setIssuer(this.cfg.jwtIssuer)
      .setAudience(this.cfg.jwtAudience)
      .setIssuedAt()
      .setExpirationTime(`${this.cfg.jwtAccessTtl}s`)
      .sign(key);
  }
}
