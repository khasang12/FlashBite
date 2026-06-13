import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { OrdersQueryService } from "./orders-query.service";
import type { OrderView } from "@flashbite/contracts";

@Controller("orders")
export class OrdersQueryController {
  constructor(private readonly orders: OrdersQueryService) {}

  @Get(":orderId")
  async get(@Param("orderId") orderId: string): Promise<OrderView> {
    const view = await this.orders.getOrder(orderId);
    if (!view) throw new NotFoundException(`Order ${orderId} not found`);
    return view;
  }
}
