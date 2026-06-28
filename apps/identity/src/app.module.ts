import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { CorrelationMiddleware, LoggerModule } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";

@Module({
  imports: [LoggerModule.forRoot("identity"), AuthModule],
  controllers: [HealthController],
  providers: [CorrelationMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
