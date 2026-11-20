import { sql } from 'drizzle-orm';
import {
  check,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { scans } from './scans.schema';
import { customers } from '..';

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),

    idempotencyKey: varchar('idempotency_key', { length: 255 })
      .notNull(),

    requestHash: varchar('request_hash', { length: 64 }).notNull(),

    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('idempotency_records_customer_key_uidx').on(
      table.customerId,
      table.idempotencyKey,
    ),

    uniqueIndex('idempotency_records_scan_id_uidx').on(table.scanId),

    check(
      'idempotency_records_key_not_empty_chk',
      sql`length(${table.idempotencyKey}) > 0`,
    ),

    check(
      'idempotency_records_request_hash_length_chk',
      sql`length(${table.requestHash}) = 64`,
    ),
  ],
);