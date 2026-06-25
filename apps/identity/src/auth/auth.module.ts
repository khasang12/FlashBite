import { Module } from "@nestjs/common";
import { PrismaService } from "@flashbite/shared";
import { KeyService } from "./key.service";
import { JwksController } from "./jwks.controller";
import { TokenService } from "./token.service";
import { RefreshTokenService } from "./refresh-token.service";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";

@Module({
  controllers: [JwksController, AuthController],
  providers: [KeyService, TokenService, RefreshTokenService, AuthService, PrismaService],
  exports: [KeyService],
})
export class AuthModule {}
