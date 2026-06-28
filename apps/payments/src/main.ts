import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { APP_LOGGER, type Logger } from "@flashbite/tenant-context";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.PAYMENTS_PORT ?? 3004);
  await app.listen(port);
  app.get<Logger>(APP_LOGGER).info(`payments listening on ${port}`);
}

bootstrap();
