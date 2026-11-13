import { pgTable, uuid, text, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    name: text('name').notNull(),
    allowedScopes: text('allowed_scopes').array().notNull(),
    isActive: boolean('is_active').notNull().default(true),

    enrollmentTokenHash: text('enrollment_token_hash'), 
    enrollmentExpiresAt: timestamp('enrollment_expires_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('oauth_clients_client_id_uq').on(t.clientId)],
);

export const oauthClientCertificates = pgTable(
  'oauth_client_certificates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    oauthClientId: uuid('oauth_client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    certificateThumbprint: text('certificate_thumbprint').notNull(),
    status: text('status').notNull().default('active'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('oauth_client_certs_thumb_uq').on(t.certificateThumbprint),
    index('oauth_client_certs_client_idx').on(t.oauthClientId),
  ],
);