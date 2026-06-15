import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * @param url optional connection string. When provided, overrides the datasource
   * url (used to connect as the restricted `flashbite_app` role for RLS). When
   * omitted, Prisma reads DATABASE_URL from the environment.
   */
  constructor(url?: string) {
    super(url ? { datasourceUrl: url } : undefined);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
