import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import * as Joi from 'joi';

const validationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  APP_PROCESS: Joi.string().valid('api', 'worker').default('api'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).required(),
  DB_POOL_MAX: Joi.number().integer().min(1).max(50).default(5),

  REDIS_HOST: Joi.string().hostname().when('APP_PROCESS', {
    is: 'worker',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_USERNAME: Joi.string().allow('').optional(),
  REDIS_PASSWORD: Joi.string().allow('').when('APP_PROCESS', {
    is: 'worker',
    then: Joi.when('NODE_ENV', {
      is: 'production',
      then: Joi.string().min(16).required(),
      otherwise: Joi.string().allow('').optional(),
    }),
    otherwise: Joi.optional(),
  }),
  REDIS_DB: Joi.number().integer().min(0).default(0),
  REDIS_TLS: Joi.boolean().truthy('true').falsy('false').default(false),
  QUEUE_PREFIX: Joi.string().min(1).max(100).default('daniya-ai-seo'),

  CHROME_PATH: Joi.when('APP_PROCESS', {
    is: 'worker',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  CHROME_NO_SANDBOX: Joi.boolean().truthy('true').falsy('false').default(false),
  BROWSER_PROXY_URL: Joi.string().uri({ scheme: ['http', 'https'] }).when('APP_PROCESS', {
    is: 'worker',
    then: Joi.when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.allow('').optional(),
    }),
    otherwise: Joi.allow('').optional(),
  }),
  BROWSER_EGRESS_REGION: Joi.string().max(64).allow('').optional(),
  ARTIFACT_STORAGE_DIR: Joi.string().min(1).max(1_024).default('./var/artifacts'),

  LIGHTHOUSE_TIMEOUT_MS: Joi.number().integer().min(30_000).max(600_000).default(180_000),
  LIGHTHOUSE_MAX_REPORT_BYTES: Joi.number().integer().min(1_048_576).max(209_715_200).default(52_428_800),
  LIGHTHOUSE_REPORT_TTL_DAYS: Joi.number().integer().min(1).max(365).default(30),

  NETWORK_OBSERVATION_MS: Joi.number().integer().min(5_000).max(90_000).default(20_000),
  NETWORK_NETLOG_MAX_BYTES: Joi.number().integer().min(1_048_576).max(314_572_800).default(104_857_600),
  NETWORK_ARTIFACT_TTL_DAYS: Joi.number().integer().min(1).max(30).default(1),
  NETWORK_DIAGNOSTIC_MAX_REQUESTS: Joi.number().integer().min(100).max(20_000).default(20_000),
  SCAN_RETENTION_DAYS: Joi.number().integer().min(7).max(365).default(90),
  ARTIFACT_RETENTION_INTERVAL_MS: Joi.number().integer().min(60_000).max(86_400_000).default(3_600_000),

  OUTBOX_POLL_INTERVAL_MS: Joi.number().integer().min(250).max(10_000).default(1_000),
  OUTBOX_CLAIM_BATCH_SIZE: Joi.number().integer().min(1).max(100).default(20),
  OUTBOX_LEASE_SECONDS: Joi.number().integer().min(10).max(900).default(60),
  ENGINE_MAX_ATTEMPTS: Joi.number().integer().min(1).max(5).default(3),
  WORKER_ID: Joi.string().max(128).allow('').optional(),
});

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      ignoreEnvFile: process.env['NODE_ENV'] === 'production',
      validationSchema,
      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
