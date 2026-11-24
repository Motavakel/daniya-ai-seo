import 'reflect-metadata';
import {
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('ApiBootstrap');
  const processType = config.getOrThrow<string>('APP_PROCESS');
  if (processType !== 'api') {
    throw new Error('APP_PROCESS must be api.');
  }
  const port = config.get<number>('PORT', 3000);

  app.useLogger(logger);
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: {
        target: false,
        value: false,
      },
    }),
  );

  await app.listen(port, '0.0.0.0');

  logger.log(`Daniya SEO API listening on port ${port}`);
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('ApiBootstrap');

  logger.error(
    error instanceof Error
      ? error.stack ?? error.message
      : String(error),
  );

  process.exitCode = 1;
});