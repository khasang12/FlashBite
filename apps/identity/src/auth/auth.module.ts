import { Module } from "@nestjs/common";
import { KeyService } from "./key.service";
import { JwksController } from "./jwks.controller";

@Module({
  controllers: [JwksController],
  providers: [KeyService],
  exports: [KeyService],
})
export class AuthModule {}
