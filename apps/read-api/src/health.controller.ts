import { Controller, Get } from "@nestjs/common";
import { getTenantId } from "@flashbite/tenant-context";

@Controller("health")
export class HealthController {
  @Get()
  check(): { status: string; tenantId: string } {
    return { status: "ok", tenantId: getTenantId() };
  }
}
