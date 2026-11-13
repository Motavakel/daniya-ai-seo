
import * as Joi from 'joi';

const dnsDomainPattern =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;

export const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production')
    .required(),

  PORT: Joi.number()
    .port()
    .required(),

  DATABASE_URL: Joi.string()
    .uri()
    .required(),

  DB_POOL_MAX: Joi.number()
    .integer()
    .min(1)
    .default(10),

  REDIS_URL: Joi.string()
    .uri()
    .required(),

  OAUTH_ACCESS_TOKEN_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(3600)
    .default(600),

  GATEWAY_DOMAIN: Joi.string()
    .pattern(dnsDomainPattern)
    .required(),

  // Client CA / PKI
  CA_DIR: Joi.string()
    .required(),

  CA_CONFIG_PATH: Joi.string()
    .required(),

  CA_CERT_PATH: Joi.string()
    .required(),

  CA_KEY_PATH: Joi.string()
    .required(),

  CA_ROOT_CERT_PATH: Joi.string()
    .required(),

  CA_KEY_PASSPHRASE: Joi.string()
    .min(16)
    .required(),

  OAUTH_CLIENT_CERT_TTL_DAYS: Joi.number()
    .integer()
    .min(1)
    .max(365)
    .default(365),

  // Gateway -> SEO Service
  SEO_API_URL: Joi.string()
    .uri()
    .required(),

  SEO_MTLS_CA_FILE: Joi.string()
    .required(),

  SEO_MTLS_CLIENT_CERT_FILE: Joi.string()
    .required(),

  SEO_MTLS_CLIENT_KEY_FILE: Joi.string()
    .required(),

  GATEWAY_SEO_JWT_PRIVATE_KEY_FILE: Joi.string()
    .required(),

  GATEWAY_SEO_JWT_KID: Joi.string()
    .required(),

  GATEWAY_SEO_JWT_ISSUER: Joi.string()
    .required(),

  GATEWAY_SEO_JWT_AUDIENCE: Joi.string()
    .required(),

  GATEWAY_SEO_JWT_TTL_SECONDS: Joi.number()
    .integer()
    .min(10)
    .max(120)
    .default(120),

}).unknown(true);
