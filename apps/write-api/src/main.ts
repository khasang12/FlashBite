import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { requireAppDatabaseUrl } from "@flashbite/shared";
import { APP_LOGGER, type Logger } from "@flashbite/tenant-context";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  requireAppDatabaseUrl(); // fail loud if the restricted RLS role isn't configured
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.WRITE_API_PORT ?? 3001);
  await app.listen(port);
  app.get<Logger>(APP_LOGGER).info(`write-api listening on ${port}`);
}

bootstrap();
