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
import { engineTypeEnum, reportFindingSeverityEnum } from './enums.schema';
import { scans } from './scans.schema';
import type { JsonObject } from './schema.types';

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),

    schemaVersion: varchar('schema_version', { length: 32 }).notNull(),
    summary: jsonb('summary')
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('reports_scan_id_uq').on(table.scanId),
    index('reports_generated_at_idx').on(table.generatedAt),
  ],
);

export const reportFindings = pgTable(
  'report_findings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),

    engine: engineTypeEnum('engine').notNull(),
    ruleId: varchar('rule_id', { length: 128 }).notNull(),
    ruleVersion: varchar('rule_version', { length: 64 }).notNull(),
    severity: reportFindingSeverityEnum('severity').notNull(),

    title: varchar('title', { length: 255 }).notNull(),
    description: text('description').notNull(),
    evidence: jsonb('evidence')
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    recommendation: text('recommendation').notNull(),

    // A rule may group several affected resources into one finding.
    affectedResourceCount: integer('affected_resource_count').notNull().default(1),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),

    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('report_findings_report_fingerprint_uq').on(
      table.reportId,
      table.fingerprint,
    ),
    index('report_findings_report_severity_idx').on(
      table.reportId,
      table.severity,
    ),
    index('report_findings_rule_id_idx').on(table.ruleId),
    check(
      'report_findings_affected_resource_count_positive_chk',
      sql`${table.affectedResourceCount} > 0`,
    ),
  ],
);

