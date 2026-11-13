import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAtColumn, updatedAtColumn } from './column.helpers';
import {
  scanProfileEnum,
  scanStatusEnum,
  scanStrategyEnum,
} from './enums.schema';
import type { JsonObject } from './schema.types';

export const scans = pgTable(
  'scans',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Trusted caller identifier forwarded by the Gateway. No local user table.
    callerRef: varchar('caller_ref', { length: 128 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),

    targetUrl: text('target_url').notNull(),
    hostname: varchar('hostname', { length: 253 }).notNull(),

    profile: scanProfileEnum('profile').notNull(),
    strategy: scanStrategyEnum('strategy').notNull(),
    status: scanStatusEnum('status').notNull().default('queued'),

    requestOptions: jsonb('request_options')
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    retryCount: integer('retry_count').notNull().default(0),
    errorCode: varchar('error_code', { length: 64 }),
    errorMessage: text('error_message'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('scans_caller_idempotency_uq')
      .on(table.callerRef, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index('scans_status_created_at_idx').on(table.status, table.createdAt),
    index('scans_caller_created_at_idx').on(table.callerRef, table.createdAt),
    index('scans_hostname_created_at_idx').on(table.hostname, table.createdAt),
    index('scans_expires_at_idx').on(table.expiresAt),
    check('scans_retry_count_non_negative_chk', sql`${table.retryCount} >= 0`),
    check(
      'scans_profile_strategy_consistency_chk',
      sql`(${table.profile} = 'basic' AND ${table.strategy} = 'lighthouse_only') OR (${table.profile} = 'detailed' AND ${table.strategy} = 'lighthouse_then_network')`,
    ),
  ],
);

