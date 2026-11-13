import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB } from '../database/database.constants';
import * as schema from '../database/schema';

type Customer = typeof schema.customers.$inferSelect;

@Injectable()
export class CustomersService {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}

  async findOrCreateIdentity(clientId: string, externalUserId: string): Promise<Customer> {
    const [client] = await this.db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, clientId))
      .limit(1);
    if (!client) throw new UnauthorizedException('Unknown client');

    const findExisting = () =>
      this.db
        .select({ customer: schema.customers })
        .from(schema.customerIdentities)
        .innerJoin(
          schema.customers,
          eq(schema.customers.id, schema.customerIdentities.customerId),
        )
        .where(
          and(
            eq(schema.customerIdentities.oauthClientId, client.id),
            eq(schema.customerIdentities.externalUserId, externalUserId),
          ),
        )
        .limit(1);

    const existing = await findExisting();
    if (existing[0]) return existing[0].customer;

    const [created] = await this.db
      .insert(schema.customers)
      .values({ status: 'active' })
      .returning();

    const inserted = await this.db
      .insert(schema.customerIdentities)
      .values({
        customerId: created.id,
        oauthClientId: client.id,
        externalUserId,
      })
      .onConflictDoNothing({
        target: [
          schema.customerIdentities.oauthClientId,
          schema.customerIdentities.externalUserId,
        ],
      })
      .returning();

    if (inserted.length > 0) return created;

    // race: یک درخواست هم‌زمان موفق شد؛ Customer تکراری را پاک و برنده را برمی‌گردانیم
    await this.db.delete(schema.customers).where(eq(schema.customers.id, created.id));
    const winner = await findExisting();
    if (!winner[0]) throw new Error('Concurrency anomaly in customer identity creation');
    return winner[0].customer;
  }
}