import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAtColumn } from './column.helpers';
import { artifactKindEnum } from './enums.schema';
import { reports } from './reports.schema';
import { scanEngineRuns } from './scan-engine-runs.schema';
import { scans } from './scans.schema';

export const reportArtifacts = pgTable(
  'report_artifacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    engineRunId: uuid('engine_run_id').references(() => scanEngineRuns.id, {
      onDelete: 'set null',
    }),
    reportId: uuid('report_id').references(() => reports.id, {
      onDelete: 'set null',
    }),

    kind: artifactKindEnum('kind').notNull(),
    storageProvider: varchar('storage_provider', { length: 32 }).notNull(),
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    fileName: varchar('file_name', { length: 255 }),
    contentType: varchar('content_type', { length: 127 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksumSha256: varchar('checksum_sha256', { length: 64 }),

    // Raw NetLog is sensitive and should have a short retention window.
    isSensitive: boolean('is_sensitive').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('report_artifacts_storage_key_uq').on(table.storageKey),
    index('report_artifacts_scan_created_at_idx').on(
      table.scanId,
      table.createdAt,
    ),
    index('report_artifacts_engine_run_idx').on(table.engineRunId),
    index('report_artifacts_report_idx').on(table.reportId),
    index('report_artifacts_expiry_idx').on(table.expiresAt),
    check('report_artifacts_size_non_negative_chk', sql`${table.sizeBytes} >= 0`),
  ],
);
