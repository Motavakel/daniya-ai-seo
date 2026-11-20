import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { scanEngineRuns } from '../workflow/scan-engine-runs.schema';
import { scans } from '../workflow/scans.schema';



export const reportArtifacts = pgTable(
  'report_artifacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),

    engineRunId: uuid('engine_run_id').references(
      () => scanEngineRuns.id,
      { onDelete: 'cascade' },
    ),

    artifactType: varchar('artifact_type', {
      length: 40,
    }).notNull(),

    storageProvider: varchar('storage_provider', {
      length: 32,
    })
      .notNull()
      .default('local'),

    // Relative storage key, not an absolute filesystem path.
    storageKey: varchar('storage_key', {
      length: 1024,
    }).notNull(),

    mimeType: varchar('mime_type', {
      length: 127,
    }).notNull(),

    compression: varchar('compression', {
      length: 16,
    }),

    sizeBytes: bigint('size_bytes', {
      mode: 'number',
    }).notNull(),

    checksumSha256: varchar('checksum_sha256', {
      length: 64,
    }).notNull(),

    metadata: jsonb('metadata')
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    expiresAt: timestamp('expires_at', {
      withTimezone: true,
    }),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('report_artifacts_storage_key_uq').on(
      table.storageKey,
    ),

    index('report_artifacts_scan_created_at_idx').on(
      table.scanId,
      table.createdAt,
    ),

    index('report_artifacts_engine_run_idx').on(
      table.engineRunId,
    ),

    index('report_artifacts_expires_at_idx').on(
      table.expiresAt,
    ),

    check(
      'report_artifacts_type_chk',
      sql`${table.artifactType} IN (
        'lighthouse_json',
        'lighthouse_html',
        'network_netlog',
        'network_report',
        'performance_trace',
        'console_report',
        'scan_report'
      )`,
    ),

    check(
      'report_artifacts_compression_chk',
      sql`${table.compression} IS NULL OR ${table.compression} IN ('gzip', 'br', 'none')`,
    ),

    check(
      'report_artifacts_size_non_negative_chk',
      sql`${table.sizeBytes} >= 0`,
    ),

    check(
      'report_artifacts_checksum_format_chk',
      sql`${table.checksumSha256} ~ '^[a-fA-F0-9]{64}$'`,
    ),

    check(
      'report_artifacts_expiry_chk',
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);