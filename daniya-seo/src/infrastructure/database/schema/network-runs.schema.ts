import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { createdAtColumn } from './column.helpers';
import { scanEngineRuns } from './scan-engine-runs.schema';
import { scans } from './scans.schema';
import type { JsonObject } from './schema.types';

export const networkRuns = pgTable(
  'network_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    engineRunId: uuid('engine_run_id')
      .notNull()
      .references(() => scanEngineRuns.id, { onDelete: 'cascade' }),

    chromeVersion: varchar('chrome_version', { length: 64 }),
    netlogVersion: varchar('netlog_version', { length: 64 }),
    parserVersion: varchar('parser_version', { length: 64 }),

    captureStartedAt: timestamp('capture_started_at', { withTimezone: true }),
    captureFinishedAt: timestamp('capture_finished_at', { withTimezone: true }),
    observationDurationMs: numeric('observation_duration_ms', {
      precision: 14,
      scale: 3,
    }),

    totalRequests: integer('total_requests').notNull().default(0),
    failedRequests: integer('failed_requests').notNull().default(0),
    totalTransferredBytes: bigint('total_transferred_bytes', { mode: 'number' }),
    totalEncodedBodyBytes: bigint('total_encoded_body_bytes', { mode: 'number' }),
    totalDecodedBodyBytes: bigint('total_decoded_body_bytes', { mode: 'number' }),

    // Viewport, cache state, timeout, egress region, and other capture settings.
    captureContext: jsonb('capture_context')
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('network_runs_engine_run_uq').on(table.engineRunId),
    index('network_runs_scan_created_at_idx').on(table.scanId, table.createdAt),
    check('network_runs_total_requests_non_negative_chk', sql`${table.totalRequests} >= 0`),
    check('network_runs_failed_requests_non_negative_chk', sql`${table.failedRequests} >= 0`),
    check(
      'network_runs_failed_requests_lte_total_chk',
      sql`${table.failedRequests} <= ${table.totalRequests}`,
    ),
    check(
      'network_runs_byte_counts_non_negative_chk',
      sql`(${table.totalTransferredBytes} IS NULL OR ${table.totalTransferredBytes} >= 0) AND (${table.totalEncodedBodyBytes} IS NULL OR ${table.totalEncodedBodyBytes} >= 0) AND (${table.totalDecodedBodyBytes} IS NULL OR ${table.totalDecodedBodyBytes} >= 0)`,
    ),
    check(
      'network_runs_observation_duration_non_negative_chk',
      sql`${table.observationDurationMs} IS NULL OR ${table.observationDurationMs} >= 0`,
    ),
  ],
);
