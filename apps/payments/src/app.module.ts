import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { PaymentsModule } from "./payments.module";

@Module({
  imports: [PaymentsModule],
  controllers: [HealthController],
})
export class AppModule {}
