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

import { scanEngineRuns } from './scan-engine-runs.schema';
import { scans } from './scans.schema';
import type { FieldAvailability, JsonObject } from '../schema.types';

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

    chromeVersion: varchar('chrome_version', {
      length: 64,
    }),

    requestedUrl: text('requested_url'),
    finalUrl: text('final_url'),

    captureStartedAt: timestamp('capture_started_at', {
      withTimezone: true,
    }),

    captureFinishedAt: timestamp('capture_finished_at', {
      withTimezone: true,
    }),

    observationDurationMs: integer('observation_duration_ms'),

    summary: jsonb('summary')
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    fieldAvailability: jsonb('field_availability')
      .$type<FieldAvailability>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('network_runs_engine_run_uq').on(
      table.engineRunId,
    ),

    index('network_runs_scan_created_at_idx').on(
      table.scanId,
      table.createdAt,
    ),

    check(
      'network_runs_observation_duration_non_negative_chk',
      sql`${table.observationDurationMs} IS NULL OR ${table.observationDurationMs} >= 0`,
    ),

    check(
      'network_runs_capture_time_range_chk',
      sql`
        ${table.captureStartedAt} IS NULL
        OR ${table.captureFinishedAt} IS NULL
        OR ${table.captureFinishedAt} >= ${table.captureStartedAt}
      `,
    ),
  ],
);