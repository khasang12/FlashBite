import { Controller, Get } from "@nestjs/common";
import { TenantCatalogService } from "@flashbite/shared";
import type { TenantView } from "@flashbite/contracts";

@Controller("tenants")
export class TenantsController {
  constructor(private readonly catalog: TenantCatalogService) {}

  @Get()
  list(): Promise<TenantView[]> {
    return this.catalog.list();
  }
}
