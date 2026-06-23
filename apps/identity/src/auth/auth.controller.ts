import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { loadConfig, type AppConfig } from "@flashbite/shared";
import { AuthService, type LoginResult } from "./auth.service";
import { LoginDto } from "./login.dto";
import { parseCookie, buildSetCookie, clearSetCookie } from "./cookie";

// Minimal structural types — avoids depending on @types/express.
type ReqLike = { headers: { cookie?: string; "x-fb-app"?: string | string[] } };
type ResLike = { setHeader: (name: string, value: string) => void };

@Controller("auth")
export class AuthController {
  private readonly cfg: AppConfig = loadConfig();
  constructor(private readonly auth: AuthService) {}

  /**
   * Per-app refresh-cookie name. Browser cookies are scoped by host, NOT port, so multiple
   * frontends on localhost:31xx would otherwise share one `fb_rt` and clobber each other's
   * session. Each app sends `X-FB-App` (sanitized -> a cookie-name suffix) so they stay isolated.
   * No header -> the base name (back-compat; in prod each app is its own subdomain anyway).
   */
  private cookieName(req: ReqLike): string {
    const raw = req.headers["x-fb-app"];
    const app = (Array.isArray(raw) ? raw[0] : raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
    return app ? `${this.cfg.rtCookieName}_${app}` : this.cfg.rtCookieName;
  }

  private setRt(res: ResLike, name: string, raw: string): void {
    res.setHeader(
      "Set-Cookie",
      buildSetCookie(name, raw, {
        maxAgeSeconds: this.cfg.jwtRefreshTtl,
        secure: this.cfg.rtCookieSecure,
        path: this.cfg.rtCookiePath,
      }),
    );
  }
  private clearRt(res: ResLike, name: string): void {
    res.setHeader("Set-Cookie", clearSetCookie(name, this.cfg.rtCookiePath));
  }

  @Post("login")
  async login(@Body() dto: LoginDto, @Req() req: ReqLike, @Res({ passthrough: true }) res: ResLike): Promise<LoginResult> {
    const { access, refresh } = await this.auth.login(dto.email, dto.password);
    this.setRt(res, this.cookieName(req), refresh.raw);
    return access;
  }

  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: ReqLike, @Res({ passthrough: true }) res: ResLike): Promise<LoginResult> {
    const name = this.cookieName(req);
    const raw = parseCookie(req.headers.cookie, name);
    if (!raw) {
      this.clearRt(res, name);
      throw new UnauthorizedException("No refresh token");
    }
    try {
      const { access, refresh } = await this.auth.refresh(raw);
      this.setRt(res, name, refresh.raw);
      return access;
    } catch (e) {
      this.clearRt(res, name);
      throw e;
    }
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: ReqLike, @Res({ passthrough: true }) res: ResLike): Promise<void> {
    const name = this.cookieName(req);
    const raw = parseCookie(req.headers.cookie, name);
    if (raw) await this.auth.logout(raw);
    this.clearRt(res, name);
  }
}
