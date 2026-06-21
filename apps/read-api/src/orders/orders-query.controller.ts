import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { OrdersQueryService } from "./orders-query.service";
import { PaymentsClient } from "./payments-client";
import { currentTenant } from "../tenant-scope";
import type { OrderView, OrderPaymentView } from "@flashbite/contracts";

@Controller("orders")
export class OrdersQueryController {
  constructor(
    private readonly orders: OrdersQueryService,
    private readonly payments: PaymentsClient,
  ) {}

  @Get(":orderId")
  async get(@Param("orderId") orderId: string): Promise<OrderView> {
    const view = await this.orders.getOrder(orderId);
    if (!view) throw new NotFoundException(`Order ${orderId} not found`);
    return view;
  }

  @Get(":orderId/payment")
  async getPayment(@Param("orderId") orderId: string): Promise<OrderPaymentView> {
    const result = await this.payments.getPayment(currentTenant(), orderId);
    return { status: result?.status ?? null };
  }
}
