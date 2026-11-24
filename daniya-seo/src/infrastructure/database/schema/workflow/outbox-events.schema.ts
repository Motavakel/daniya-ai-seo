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
  text,
} from 'drizzle-orm/pg-core';

import { scans } from './scans.schema';
import { outboxEventTypeEnum, outboxEventStatusEnum } from '../enums.schema';

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),

    eventType: outboxEventTypeEnum('event_type').notNull(),

    payload: jsonb('payload')
      .$type<{ scanId: string }>()
      .notNull(),

    status: outboxEventStatusEnum('status')
      .notNull()
      .default('pending'),

    attempts: integer('attempts').notNull().default(0),

    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    lockedAt: timestamp('locked_at', { withTimezone: true }),

    lockToken: uuid('lock_token'),

    publishedAt: timestamp('published_at', { withTimezone: true }),

    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('outbox_events_scan_event_type_uidx').on(
      table.scanId,
      table.eventType,
    ),

    index('outbox_events_dispatch_idx').on(
      table.status,
      table.nextAttemptAt,
    ),

    check(
      'outbox_events_attempts_non_negative_chk',
      sql`${table.attempts} >= 0`,
    ),

    check(
      'outbox_events_lock_fields_chk',
      sql`
        (
          ${table.status} = 'processing'
          AND ${table.lockedAt} IS NOT NULL
          AND ${table.lockToken} IS NOT NULL
        )
        OR
        (
          ${table.status} <> 'processing'
          AND ${table.lockedAt} IS NULL
          AND ${table.lockToken} IS NULL
        )
      `,
    ),

    check(
      'outbox_events_published_at_chk',
      sql`
        (
          ${table.status} = 'published'
          AND ${table.publishedAt} IS NOT NULL
        )
        OR
        (
          ${table.status} <> 'published'
          AND ${table.publishedAt} IS NULL
        )
      `,
    ),
  ],
);