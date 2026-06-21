import { Module } from "@nestjs/common";
import { PrismaService, loadConfig } from "@flashbite/shared";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { AcceptController } from "./accept.controller";
import { ConfirmPaymentController } from "./confirm-payment.controller";
import { DispatchController } from "./dispatch.controller";
import { TemporalService } from "../temporal/temporal.service";
import { PaymentsClient } from "./payments-client";

@Module({
  controllers: [OrdersController, AcceptController, ConfirmPaymentController, DispatchController],
  providers: [
    OrdersService,
    { provide: PrismaService, useFactory: () => new PrismaService(loadConfig().appDatabaseUrl) },
    TemporalService,
    PaymentsClient,
  ],
})
export class OrdersModule {}
