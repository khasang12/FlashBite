import { Controller, Get } from "@nestjs/common";
import type { JWK } from "jose";
import { KeyService } from "./key.service";

@Controller(".well-known")
export class JwksController {
  constructor(private readonly keys: KeyService) {}

  @Get("jwks.json")
  jwks(): { keys: JWK[] } {
    return this.keys.jwks();
  }
}
