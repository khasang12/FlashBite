import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { createLogger } from "@flashbite/shared";
import { AppModule } from "./app.module";

const log = createLogger("payments");

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.PAYMENTS_PORT ?? 3004);
  await app.listen(port);
  log.info(`payments listening on ${port}`);
}

bootstrap();
