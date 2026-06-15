import { Body, Controller, Post } from "@nestjs/common";
import { AuthService, type LoginResult } from "./auth.service";
import { LoginDto } from "./login.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto.email, dto.password);
  }
}
