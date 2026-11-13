import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  text,
} from 'drizzle-orm/pg-core';
import { createdAtColumn } from './column.helpers';
import { networkRuns } from './network-runs.schema';
import { networkRequests } from './network-requests.schema';
import { reportFindingSeverityEnum } from './enums.schema';
import type { JsonObject } from './schema.types';

/** Rule output tied to one network capture, before final report aggregation. */
export const networkFindings = pgTable(
  'network_findings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    networkRunId: uuid('network_run_id')
      .notNull()
      .references(() => networkRuns.id, { onDelete: 'cascade' }),
    requestId: bigint('request_id', { mode: 'number' }).references(
      () => networkRequests.id,
      { onDelete: 'set null' },
    ),

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
    affectedResourceCount: integer('affected_resource_count').notNull().default(1),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),

    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('network_findings_run_fingerprint_uq').on(
      table.networkRunId,
      table.fingerprint,
    ),
    index('network_findings_run_severity_idx').on(
      table.networkRunId,
      table.severity,
    ),
    index('network_findings_rule_id_idx').on(table.ruleId),
    index('network_findings_request_idx').on(table.requestId),
    check(
      'network_findings_affected_count_positive_chk',
      sql`${table.affectedResourceCount} > 0`,
    ),
  ],
);
