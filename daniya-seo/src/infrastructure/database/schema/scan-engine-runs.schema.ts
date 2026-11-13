import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAtColumn, updatedAtColumn } from './column.helpers';
import { engineRunStatusEnum, engineTypeEnum } from './enums.schema';
import { scans } from './scans.schema';
import type { JsonObject } from './schema.types';

export const scanEngineRuns = pgTable(
  'scan_engine_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),

    engine: engineTypeEnum('engine').notNull(),
    status: engineRunStatusEnum('status').notNull().default('queued'),
    // Every retry gets a new row, preserving the previous attempt for auditability.
    attempt: integer('attempt').notNull().default(1),

    engineVersion: varchar('engine_version', { length: 64 }),
    parserVersion: varchar('parser_version', { length: 64 }),
    workerId: varchar('worker_id', { length: 128 }),

    executionContext: jsonb('execution_context')
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: numeric('duration_ms', { precision: 14, scale: 3 }),

    errorCode: varchar('error_code', { length: 64 }),
    errorMessage: varchar('error_message', { length: 2_000 }),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('scan_engine_runs_scan_engine_attempt_uq').on(
      table.scanId,
      table.engine,
      table.attempt,
    ),
    index('scan_engine_runs_scan_engine_status_idx').on(
      table.scanId,
      table.engine,
      table.status,
    ),
    index('scan_engine_runs_status_created_at_idx').on(
      table.status,
      table.createdAt,
    ),
    check('scan_engine_runs_attempt_positive_chk', sql`${table.attempt} > 0`),
    check(
      'scan_engine_runs_duration_non_negative_chk',
      sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`,
    ),
  ],
);
