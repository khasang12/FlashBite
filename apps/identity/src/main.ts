import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.IDENTITY_PORT ?? 3003);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`identity listening on ${port}`);
}

bootstrap();
