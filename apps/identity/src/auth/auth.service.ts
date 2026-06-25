import { Injectable, UnauthorizedException } from "@nestjs/common";
import argon2 from "argon2";
import { PrismaService } from "@flashbite/shared";
import { TokenService } from "./token.service";
import { RefreshTokenService } from "./refresh-token.service";

export interface LoginResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

export interface AuthIssue {
  access: LoginResult;
  refresh: { raw: string; expiresAt: Date };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  private async access(user: { id: string; tenantId: string; role: string }): Promise<LoginResult> {
    const accessToken = await this.tokens.sign({ sub: user.id, tenantId: user.tenantId, role: user.role });
    return { accessToken, tokenType: "Bearer", expiresIn: this.tokens.ttlSeconds() };
  }

  async login(email: string, password: string): Promise<AuthIssue> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Verify even when the user is missing, to avoid timing-based user enumeration.
    const hash = user?.passwordHash ?? "$argon2id$v=19$m=65536,t=3,p=4$0000000000000000$0000000000000000000000000000000000000000000";
    let ok = false;
    try {
      ok = await argon2.verify(hash, password);
    } catch {
      ok = false;
    }
    if (!user || !ok) {
      throw new UnauthorizedException("Invalid email or password");
    }
    const access = await this.access(user);
    const refresh = await this.refreshTokens.issue(user.id, user.tenantId);
    return { access, refresh };
  }

  /** Rotate the refresh token and mint a fresh access token from the user's CURRENT role/tenant. */
  async refresh(rawToken: string): Promise<AuthIssue> {
    const r = await this.refreshTokens.rotate(rawToken);
    if (!r.ok) throw new UnauthorizedException("Invalid refresh token");
    const user = await this.prisma.user.findUnique({ where: { id: r.userId } });
    if (!user) throw new UnauthorizedException("Invalid refresh token");
    const access = await this.access(user);
    return { access, refresh: { raw: r.raw, expiresAt: r.expiresAt } };
  }

  async logout(rawToken: string): Promise<void> {
    await this.refreshTokens.revoke(rawToken);
  }
}
