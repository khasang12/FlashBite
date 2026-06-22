import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { loadConfig, type AppConfig } from "@flashbite/shared";
import { AuthService, type LoginResult } from "./auth.service";
import { LoginDto } from "./login.dto";
import { parseCookie, buildSetCookie, clearSetCookie } from "./cookie";

// Minimal structural types — avoids depending on @types/express.
type ReqLike = { headers: { cookie?: string } };
type ResLike = { setHeader: (name: string, value: string) => void };

@Controller("auth")
export class AuthController {
  private readonly cfg: AppConfig = loadConfig();
  constructor(private readonly auth: AuthService) {}

  private setRt(res: ResLike, raw: string): void {
    res.setHeader(
      "Set-Cookie",
      buildSetCookie(this.cfg.rtCookieName, raw, {
        maxAgeSeconds: this.cfg.jwtRefreshTtl,
        secure: this.cfg.rtCookieSecure,
        path: this.cfg.rtCookiePath,
      }),
    );
  }
  private clearRt(res: ResLike): void {
    res.setHeader("Set-Cookie", clearSetCookie(this.cfg.rtCookieName, this.cfg.rtCookiePath));
  }

  @Post("login")
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: ResLike): Promise<LoginResult> {
    const { access, refresh } = await this.auth.login(dto.email, dto.password);
    this.setRt(res, refresh.raw);
    return access;
  }

  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: ReqLike, @Res({ passthrough: true }) res: ResLike): Promise<LoginResult> {
    const raw = parseCookie(req.headers.cookie, this.cfg.rtCookieName);
    if (!raw) {
      this.clearRt(res);
      throw new UnauthorizedException("No refresh token");
    }
    try {
      const { access, refresh } = await this.auth.refresh(raw);
      this.setRt(res, refresh.raw);
      return access;
    } catch (e) {
      this.clearRt(res);
      throw e;
    }
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: ReqLike, @Res({ passthrough: true }) res: ResLike): Promise<void> {
    const raw = parseCookie(req.headers.cookie, this.cfg.rtCookieName);
    if (raw) await this.auth.logout(raw);
    this.clearRt(res);
  }
}
