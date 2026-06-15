import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Roles } from "@flashbite/tenant-context";
import { CreateOrderDto } from "./create-order.dto";
import { OrdersService } from "./orders.service";

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(201)
  @Roles("customer")
  place(@Body() dto: CreateOrderDto): Promise<{ orderId: string }> {
    return this.orders.placeOrder(dto);
  }
}
