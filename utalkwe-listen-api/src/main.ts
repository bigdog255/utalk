import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const logger = new Logger('Bootstrap');

  app.enableCors();

  // ValidationPipe for DTOs — Vapi webhooks use raw types so they bypass this,
  // but we keep transform:true and avoid forbidNonWhitelisted to prevent
  // rejecting webhook payloads with extra fields.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`UtalkWe Listen API running on port ${port}`);
}
bootstrap();
