import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
import { createdAtColumn } from './column.helpers';
import {
  networkCacheStatusEnum,
  networkResourceTypeEnum,
  resourceTypeSourceEnum,
} from './enums.schema';
import { networkRuns } from './network-runs.schema';
import type { FieldAvailability, SafeResponseHeaders } from './schema.types';

export const networkRequests = pgTable(
  'network_requests',
  {
    // A bigint identity is more compact than UUID for potentially large request volumes.
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    networkRunId: uuid('network_run_id')
      .notNull()
      .references(() => networkRuns.id, { onDelete: 'cascade' }),

    sequenceNumber: integer('sequence_number').notNull(),
    netlogRequestId: varchar('netlog_request_id', { length: 128 }),
    redirectChainKey: varchar('redirect_chain_key', { length: 128 }),

    url: text('url').notNull(),
    urlHash: varchar('url_hash', { length: 64 }),
    hostname: varchar('hostname', { length: 253 }).notNull(),
    method: varchar('method', { length: 16 }).notNull(),
    resourceType: networkResourceTypeEnum('resource_type')
      .notNull()
      .default('unknown'),
    resourceTypeSource: resourceTypeSourceEnum('resource_type_source')
      .notNull()
      .default('unknown'),

    statusCode: integer('status_code'),
    protocol: varchar('protocol', { length: 32 }),
    isRedirect: boolean('is_redirect').notNull().default(false),
    isThirdParty: boolean('is_third_party'),
    isFromServiceWorker: boolean('is_from_service_worker'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    responseStartedAt: timestamp('response_started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    durationMs: numeric('duration_ms', { precision: 14, scale: 3 }),
    dnsDurationMs: numeric('dns_duration_ms', { precision: 14, scale: 3 }),
    connectDurationMs: numeric('connect_duration_ms', { precision: 14, scale: 3 }),
    tlsDurationMs: numeric('tls_duration_ms', { precision: 14, scale: 3 }),
    timeToFirstByteMs: numeric('time_to_first_byte_ms', {
      precision: 14,
      scale: 3,
    }),
    downloadDurationMs: numeric('download_duration_ms', {
      precision: 14,
      scale: 3,
    }),

    // Keep these separate. They are not interchangeable byte measurements.
    transferredBytes: bigint('transferred_bytes', { mode: 'number' }),
    encodedBodyBytes: bigint('encoded_body_bytes', { mode: 'number' }),
    decodedBodyBytes: bigint('decoded_body_bytes', { mode: 'number' }),

    cacheStatus: networkCacheStatusEnum('cache_status')
      .notNull()
      .default('unknown'),
    cacheControl: varchar('cache_control', { length: 1_024 }),
    ageSeconds: integer('age_seconds'),
    etag: varchar('etag', { length: 512 }),
    lastModified: varchar('last_modified', { length: 128 }),
    contentEncoding: varchar('content_encoding', { length: 128 }),

    // Strict allowlist only. No cookies, authorization, or arbitrary headers.
    responseHeaders: jsonb('response_headers')
      .$type<SafeResponseHeaders>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    // Distinguishes unavailable NetLog data from measured zero values.
    fieldAvailability: jsonb('field_availability')
      .$type<FieldAvailability>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    failureCode: varchar('failure_code', { length: 128 }),
    failureMessage: varchar('failure_message', { length: 1_000 }),

    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('network_requests_run_sequence_uq').on(
      table.networkRunId,
      table.sequenceNumber,
    ),
    index('network_requests_run_url_hash_idx').on(
      table.networkRunId,
      table.urlHash,
    ),
    index('network_requests_run_status_code_idx').on(
      table.networkRunId,
      table.statusCode,
    ),
    index('network_requests_run_resource_type_idx').on(
      table.networkRunId,
      table.resourceType,
    ),
    index('network_requests_run_hostname_idx').on(
      table.networkRunId,
      table.hostname,
    ),
    index('network_requests_run_started_at_idx').on(
      table.networkRunId,
      table.startedAt,
    ),
    check(
      'network_requests_sequence_non_negative_chk',
      sql`${table.sequenceNumber} >= 0`,
    ),
    check(
      'network_requests_status_code_range_chk',
      sql`${table.statusCode} IS NULL OR (${table.statusCode} >= 100 AND ${table.statusCode} <= 599)`,
    ),
    check(
      'network_requests_age_seconds_non_negative_chk',
      sql`${table.ageSeconds} IS NULL OR ${table.ageSeconds} >= 0`,
    ),
    check(
      'network_requests_duration_non_negative_chk',
      sql`(${table.durationMs} IS NULL OR ${table.durationMs} >= 0) AND (${table.dnsDurationMs} IS NULL OR ${table.dnsDurationMs} >= 0) AND (${table.connectDurationMs} IS NULL OR ${table.connectDurationMs} >= 0) AND (${table.tlsDurationMs} IS NULL OR ${table.tlsDurationMs} >= 0) AND (${table.timeToFirstByteMs} IS NULL OR ${table.timeToFirstByteMs} >= 0) AND (${table.downloadDurationMs} IS NULL OR ${table.downloadDurationMs} >= 0)`,
    ),
    check(
      'network_requests_bytes_non_negative_chk',
      sql`(${table.transferredBytes} IS NULL OR ${table.transferredBytes} >= 0) AND (${table.encodedBodyBytes} IS NULL OR ${table.encodedBodyBytes} >= 0) AND (${table.decodedBodyBytes} IS NULL OR ${table.decodedBodyBytes} >= 0)`,
    ),
  ],
);
