import { Module } from "@nestjs/common";
import { PaymentsPrismaService } from "./payments-prisma.service";
import { PaymentsService } from "./payments.service";
import { PaymentsController } from "./payments.controller";

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsPrismaService, PaymentsService],
})
export class PaymentsModule {}
