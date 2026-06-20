import { Module } from "@nestjs/common";
import { MongoService, RedisService } from "@flashbite/shared";
import { OrdersQueryController } from "./orders-query.controller";
import { MerchantOrdersController } from "./merchant-orders.controller";
import { OrdersQueryService } from "./orders-query.service";
import { PaymentsClient } from "./payments-client";

@Module({
  controllers: [OrdersQueryController, MerchantOrdersController],
  providers: [OrdersQueryService, MongoService, RedisService, PaymentsClient],
})
export class OrdersModule {}
