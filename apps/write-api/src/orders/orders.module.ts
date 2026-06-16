import { Module } from "@nestjs/common";
import { PrismaService, loadConfig } from "@flashbite/shared";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { AcceptController } from "./accept.controller";
import { TemporalService } from "../temporal/temporal.service";

@Module({
  controllers: [OrdersController, AcceptController],
  providers: [
    OrdersService,
    { provide: PrismaService, useFactory: () => new PrismaService(loadConfig().appDatabaseUrl) },
    TemporalService,
  ],
})
export class OrdersModule {}
