import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { scanEngineRuns } from './scan-engine-runs.schema';
import { scans } from './scans.schema';
import type { JsonObject, LighthouseAuditSummaries } from '../schema.types';
import { lighthouseFormFactorEnum, lighthouseThrottlingMethodEnum } from '../enums.schema';


export const lighthouseRuns = pgTable(
  'lighthouse_reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),

    engineRunId: uuid('engine_run_id')
      .notNull()
      .references(() => scanEngineRuns.id, { onDelete: 'cascade' }),

    lighthouseVersion: varchar('lighthouse_version', {
      length: 64,
    }),

    chromeVersion: varchar('chrome_version', {
      length: 64,
    }),

    formFactor: lighthouseFormFactorEnum('form_factor'),

    throttlingMethod: lighthouseThrottlingMethodEnum(
      'throttling_method',
    ),
    
    requestedUrl: text('requested_url'),
    finalUrl: text('final_url'),

    fetchedAt: timestamp('fetched_at', {
      withTimezone: true,
    }),

    userAgent: varchar('user_agent', {
      length: 512,
    }),

    performanceScore: numeric('performance_score', {
      precision: 5,
      scale: 4,
    }),

    accessibilityScore: numeric('accessibility_score', {
      precision: 5,
      scale: 4,
    }),

    bestPracticesScore: numeric('best_practices_score', {
      precision: 5,
      scale: 4,
    }),

    seoScore: numeric('seo_score', {
      precision: 5,
      scale: 4,
    }),

    firstContentfulPaintMs: numeric('first_contentful_paint_ms', {
      precision: 14,
      scale: 3,
    }),

    largestContentfulPaintMs: numeric(
      'largest_contentful_paint_ms',
      {
        precision: 14,
        scale: 3,
      },
    ),

    speedIndexMs: numeric('speed_index_ms', {
      precision: 14,
      scale: 3,
    }),

    totalBlockingTimeMs: numeric('total_blocking_time_ms', {
      precision: 14,
      scale: 3,
    }),

    cumulativeLayoutShift: numeric('cumulative_layout_shift', {
      precision: 12,
      scale: 6,
    }),

    timeToInteractiveMs: numeric('time_to_interactive_ms', {
      precision: 14,
      scale: 3,
    }),

    totalByteWeightBytes: bigint('total_byte_weight_bytes', {
      mode: 'number',
    }),

    networkRequests: integer('network_requests'),

    auditSummaries: jsonb('audit_summaries')
      .$type<LighthouseAuditSummaries>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    categoryDetails: jsonb('category_details')
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    runWarnings: jsonb('run_warnings')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('lighthouse_reports_engine_run_uq').on(
      table.engineRunId,
    ),

    index('lighthouse_reports_scan_created_at_idx').on(
      table.scanId,
      table.createdAt,
    ),

    check(
      'lighthouse_reports_performance_score_range_chk',
      sql`${table.performanceScore} IS NULL OR (${table.performanceScore} >= 0 AND ${table.performanceScore} <= 1)`,
    ),

    check(
      'lighthouse_reports_accessibility_score_range_chk',
      sql`${table.accessibilityScore} IS NULL OR (${table.accessibilityScore} >= 0 AND ${table.accessibilityScore} <= 1)`,
    ),

    check(
      'lighthouse_reports_best_practices_score_range_chk',
      sql`${table.bestPracticesScore} IS NULL OR (${table.bestPracticesScore} >= 0 AND ${table.bestPracticesScore} <= 1)`,
    ),

    check(
      'lighthouse_reports_seo_score_range_chk',
      sql`${table.seoScore} IS NULL OR (${table.seoScore} >= 0 AND ${table.seoScore} <= 1)`,
    ),

    check(
      'lighthouse_reports_metrics_non_negative_chk',
      sql`
        (${table.firstContentfulPaintMs} IS NULL OR ${table.firstContentfulPaintMs} >= 0)
        AND (${table.largestContentfulPaintMs} IS NULL OR ${table.largestContentfulPaintMs} >= 0)
        AND (${table.speedIndexMs} IS NULL OR ${table.speedIndexMs} >= 0)
        AND (${table.totalBlockingTimeMs} IS NULL OR ${table.totalBlockingTimeMs} >= 0)
        AND (${table.cumulativeLayoutShift} IS NULL OR ${table.cumulativeLayoutShift} >= 0)
        AND (${table.timeToInteractiveMs} IS NULL OR ${table.timeToInteractiveMs} >= 0)
        AND (${table.totalByteWeightBytes} IS NULL OR ${table.totalByteWeightBytes} >= 0)
      `,
    ),

    check(
      'lighthouse_reports_network_requests_non_negative_chk',
      sql`${table.networkRequests} IS NULL OR ${table.networkRequests} >= 0`,
    ),
  ],
);