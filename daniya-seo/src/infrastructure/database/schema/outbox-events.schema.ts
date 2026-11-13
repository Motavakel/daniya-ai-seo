import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAtColumn, updatedAtColumn } from './column.helpers';
import { outboxStatusEnum } from './enums.schema';
import { scans } from './scans.schema';
import type { JsonObject } from './schema.types';

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),

    // Examples: scan.lighthouse.requested, scan.network.requested.
    eventType: varchar('event_type', { length: 120 }).notNull(),
    eventKey: varchar('event_key', { length: 180 }).notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),

    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),

    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: varchar('locked_by', { length: 128 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),

    lastError: varchar('last_error', { length: 2_000 }),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('outbox_events_event_key_uq').on(table.eventKey),
    index('outbox_events_status_available_at_idx').on(
      table.status,
      table.availableAt,
    ),
    index('outbox_events_scan_created_at_idx').on(
      table.scanId,
      table.createdAt,
    ),
    check('outbox_events_attempts_non_negative_chk', sql`${table.attempts} >= 0`),
    check('outbox_events_max_attempts_positive_chk', sql`${table.maxAttempts} > 0`),
    check(
      'outbox_events_attempts_lte_max_chk',
      sql`${table.attempts} <= ${table.maxAttempts}`,
    ),
  ],
);
