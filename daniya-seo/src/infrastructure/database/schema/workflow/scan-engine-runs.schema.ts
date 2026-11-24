import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  scanEngineTypeEnum,
  scanEngineRunStatusEnum,
} from '../enums.schema';

import { scans } from './scans.schema';

export const scanEngineRuns = pgTable(
  'scan_engine_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),

    engineType: scanEngineTypeEnum('engine_type').notNull(),

    status: scanEngineRunStatusEnum('status')
      .notNull()
      .default('queued'),

    attempts: integer('attempts').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true }),

    completedAt: timestamp('completed_at', { withTimezone: true }),

    lockToken: uuid('lock_token'),

    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
    }),

    errorCode: varchar('error_code', { length: 100 }),

    errorMessage: varchar('error_message', { length: 2000 }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('scan_engine_runs_scan_engine_uidx').on(
      table.scanId,
      table.engineType,
    ),

    index('scan_engine_runs_scan_status_idx').on(
      table.scanId,
      table.status,
    ),

    index('scan_engine_runs_lease_expiry_idx').on(
      table.leaseExpiresAt,
    ),

    check(
      'scan_engine_runs_attempts_non_negative_chk',
      sql`${table.attempts} >= 0`,
    ),

    check(
      'scan_engine_runs_status_timestamps_chk',
      sql`
        (
          ${table.status} = 'queued'
          AND ${table.startedAt} IS NULL
          AND ${table.completedAt} IS NULL
          AND ${table.lockToken} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
        )
        OR
        (
          ${table.status} = 'running'
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NULL
          AND ${table.lockToken} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
        )
        OR
        (
          ${table.status} IN ('completed', 'failed')
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.lockToken} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
        )
      `,
    ),
  ],
);