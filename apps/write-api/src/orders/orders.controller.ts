import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Roles } from "@flashbite/tenant-context";
import { ROLES } from "@flashbite/contracts";
import { CreateOrderDto } from "./create-order.dto";
import { OrdersService } from "./orders.service";

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(201)
  @Roles(ROLES.CUSTOMER)
  place(@Body() dto: CreateOrderDto): Promise<{ orderId: string }> {
    return this.orders.placeOrder(dto);
  }
}
