import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const supportRequests = pgTable(
  'support_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').notNull(),
    serviceType: text('service_type').notNull(),
    pageUrl: text('page_url').notNull(),
    description: text('description'),
    consentAt: timestamp('consent_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('pending'),
    quotedAmountMinor: integer('quoted_amount_minor'),
    currency: text('currency'),
    quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('support_requests_customer_idx').on(t.customerId)],
);
