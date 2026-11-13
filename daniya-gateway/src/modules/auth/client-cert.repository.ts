import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../database/schema';
import { DB } from '../../database/database.constants';

@Injectable()
export class ClientCertRepository {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async findActiveByThumbprint(thumbprint: string) {
    const now = new Date();

    const rows = await this.db
      .select({
        client: schema.oauthClients,
        cert: schema.oauthClientCertificates,
      })
      .from(schema.oauthClientCertificates)
      .innerJoin(
        schema.oauthClients,
        eq(
          schema.oauthClients.id,
          schema.oauthClientCertificates.oauthClientId,
        ),
      )
      .where(
        and(
          eq(schema.oauthClientCertificates.certificateThumbprint, thumbprint),
          eq(schema.oauthClientCertificates.status, 'active'),
          eq(schema.oauthClients.isActive, true),
          isNull(schema.oauthClientCertificates.revokedAt),
          lte(schema.oauthClientCertificates.validFrom, now),
          or(
            isNull(schema.oauthClientCertificates.validUntil),
            gt(schema.oauthClientCertificates.validUntil, now),
          ),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }
}