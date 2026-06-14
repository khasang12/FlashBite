import { Module } from "@nestjs/common";
import { MongoService, RedisService } from "@flashbite/shared";
import { OrdersQueryController } from "./orders-query.controller";
import { MerchantOrdersController } from "./merchant-orders.controller";
import { OrdersQueryService } from "./orders-query.service";

@Module({
  controllers: [OrdersQueryController, MerchantOrdersController],
  providers: [OrdersQueryService, MongoService, RedisService],
})
export class OrdersModule {}
