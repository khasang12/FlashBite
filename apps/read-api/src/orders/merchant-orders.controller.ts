import { Controller, Get } from "@nestjs/common";
import { OrdersQueryService } from "./orders-query.service";
import type { OrderView } from "@flashbite/contracts";

@Controller("merchant/orders")
export class MerchantOrdersController {
  constructor(private readonly orders: OrdersQueryService) {}

  // GET /merchant/orders — distinct from the SSE GET /merchant/orders/stream.
  @Get()
  async list(): Promise<OrderView[]> {
    return this.orders.listRecentOrders();
  }
}
