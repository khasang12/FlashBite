import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.READ_API_PORT ?? 3002);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`read-api listening on ${port}`);
}

bootstrap();
