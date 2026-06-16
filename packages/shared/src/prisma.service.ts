import { Injectable, Optional, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * @param url optional connection string. When provided, overrides the datasource
   * url (used to connect as the restricted `flashbite_app` role for RLS). When
   * omitted, Prisma reads DATABASE_URL from the environment.
   *
   * `@Optional()` so Nest DI does not try to resolve the `string` param as a token
   * when PrismaService is provided bare (e.g. identity's AuthModule).
   */
  constructor(@Optional() url?: string) {
    super(url ? { datasourceUrl: url } : undefined);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
