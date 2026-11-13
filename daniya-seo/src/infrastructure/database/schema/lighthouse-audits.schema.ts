import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  check,
} from 'drizzle-orm/pg-core';
import { createdAtColumn } from './column.helpers';
import { lighthouseReports } from './lighthouse-reports.schema';
import type { JsonObject, LighthouseAuditCategoryRef } from './schema.types';

/** One row per Lighthouse audit. Large/full report payload remains in artifact storage. */
export const lighthouseAudits = pgTable(
  'lighthouse_audits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => lighthouseReports.id, { onDelete: 'cascade' }),

    auditId: varchar('audit_id', { length: 255 }).notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    description: text('description'),
    score: numeric('score', { precision: 5, scale: 4 }),
    scoreDisplayMode: varchar('score_display_mode', { length: 32 }).notNull(),
    displayValue: text('display_value'),
    numericValue: numeric('numeric_value', { precision: 18, scale: 3 }),
    numericUnit: varchar('numeric_unit', { length: 32 }),
    categoryRefs: jsonb('category_refs')
      .$type<LighthouseAuditCategoryRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    details: jsonb('details')
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    warnings: jsonb('warnings')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    errorMessage: text('error_message'),

    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('lighthouse_audits_report_audit_id_uq').on(
      table.reportId,
      table.auditId,
    ),
    index('lighthouse_audits_report_score_idx').on(
      table.reportId,
      table.score,
    ),
    index('lighthouse_audits_audit_id_idx').on(table.auditId),
    check(
      'lighthouse_audits_score_range_chk',
      sql`${table.score} IS NULL OR (${table.score} >= 0 AND ${table.score} <= 1)`,
    ),
  ],
);
