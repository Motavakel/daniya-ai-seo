import * as Joi from 'joi';

export const validationSchema = Joi.object({
  // Application
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

  PORT: Joi.number().port().default(3000),

  APP_PROCESS: Joi.string()
    .min(1)
    .default('daniya-ai-seo'),

  // PostgreSQL
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),

  DB_POOL_MAX: Joi.number()
    .integer()
    .min(1)
    .max(50)
    .default(5),

  // Redis / BullMQ
  REDIS_HOST: Joi.string().hostname().required(),

  REDIS_PORT: Joi.number()
    .port()
    .default(6379),

  REDIS_USERNAME: Joi.string()
    .allow('')
    .optional(),

  REDIS_PASSWORD: Joi.string()
    .allow('')
    .optional(),

  REDIS_DB: Joi.number()
    .integer()
    .min(0)
    .default(0),

  QUEUE_PREFIX: Joi.string()
    .min(1)
    .max(100)
    .default('daniya-ai-seo'),

  // Logging
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'log', 'debug', 'verbose')
    .default('log'),

  // Gateway JWT
  SEO_GATEWAY_JWT_PUBLIC_KEY_FILE: Joi.string()
    .trim()
    .min(1)
    .required(),

  SEO_GATEWAY_JWT_ISSUER: Joi.string()
    .uri({ scheme: ['https'] })
    .required(),

  SEO_GATEWAY_JWT_AUDIENCE: Joi.string()
    .trim()
    .min(1)
    .required(),

  SEO_GATEWAY_JWT_KID: Joi.string()
    .trim()
    .min(1)
    .required(),

  // Chrome
  CHROME_PATH: Joi.string()
    .allow('')
    .default(''),

  CHROME_NO_SANDBOX: Joi.boolean()
    .default(false),

  // Network
  NETWORK_OBSERVATION_SECONDS: Joi.number()
    .integer()
    .min(1)
    .default(60),

  NETLOG_MAX_SIZE_MB: Joi.number()
    .integer()
    .min(1)
    .default(200),
});