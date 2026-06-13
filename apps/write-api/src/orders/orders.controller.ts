import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { CreateOrderDto } from "./create-order.dto";
import { OrdersService } from "./orders.service";

@Controller("orders")
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(201)
  place(@Body() dto: CreateOrderDto): Promise<{ orderId: string }> {
    return this.orders.placeOrder(dto);
  }
}
