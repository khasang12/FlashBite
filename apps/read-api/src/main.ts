import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { APP_LOGGER, type Logger } from "@flashbite/tenant-context";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.READ_API_PORT ?? 3002);
  await app.listen(port);
  app.get<Logger>(APP_LOGGER).info(`read-api listening on ${port}`);
}

bootstrap();
