import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createLogger } from "@flashbite/shared";
import { AppModule } from "./app.module";

const log = createLogger("read-api");

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.READ_API_PORT ?? 3002);
  await app.listen(port);
  log.info(`read-api listening on ${port}`);
}

bootstrap();
