import { sql } from 'drizzle-orm';

import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { customers } from '../access/customers.schema';

export const pages = pgTable(
  'pages',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, {
        onDelete: 'restrict',
      }),

    normalizedUrl: text('normalized_url').notNull(),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp('updated_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('pages_customer_normalized_url_unique').on(
      table.customerId,
      table.normalizedUrl,
    ),

    check(
      'pages_normalized_url_check',
      sql`
        char_length(${table.normalizedUrl}) > 0
        AND ${table.normalizedUrl} = btrim(${table.normalizedUrl})
      `,
    ),
  ],
);