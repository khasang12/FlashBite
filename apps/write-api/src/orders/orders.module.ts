import { Module } from "@nestjs/common";
import { PrismaService } from "@flashbite/shared";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { AcceptController } from "./accept.controller";
import { TemporalService } from "../temporal/temporal.service";

@Module({
  controllers: [OrdersController, AcceptController],
  providers: [OrdersService, PrismaService, TemporalService],
})
export class OrdersModule {}
