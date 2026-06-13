import { Module } from "@nestjs/common";
import { MongoService } from "@flashbite/shared";
import { OrdersQueryController } from "./orders-query.controller";
import { OrdersQueryService } from "./orders-query.service";

@Module({
  controllers: [OrdersQueryController],
  providers: [OrdersQueryService, MongoService],
})
export class OrdersModule {}
