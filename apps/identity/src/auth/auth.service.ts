import { Injectable, UnauthorizedException } from "@nestjs/common";
import argon2 from "argon2";
import { PrismaService } from "@flashbite/shared";
import { TokenService } from "./token.service";

export interface LoginResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
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
    const accessToken = await this.tokens.sign({ sub: user.id, tenantId: user.tenantId, role: user.role });
    return { accessToken, tokenType: "Bearer", expiresIn: this.tokens.ttlSeconds() };
  }
}
