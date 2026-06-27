import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { createLogger } from "@flashbite/shared";
import { AppModule } from "./app.module";

const log = createLogger("identity");

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.IDENTITY_PORT ?? 3003);
  await app.listen(port);
  log.info(`identity listening on ${port}`);
}

bootstrap();
