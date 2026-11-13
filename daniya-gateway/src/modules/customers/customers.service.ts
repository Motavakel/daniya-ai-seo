import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { and, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../database/database.constants';
import * as schema from '../../database/schema';

type Customer = typeof schema.customers.$inferSelect;

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DB)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async findOrCreateIdentity(
    clientId: string,
    externalUserId: string,
  ): Promise<Customer> {
    const normalizedUserId = externalUserId.trim();

    if (!normalizedUserId) {
      throw new BadRequestException('External user ID is required');
    }

    const [client] = await this.db
      .select()
      .from(schema.oauthClients)
      .where(
        and(
          eq(schema.oauthClients.clientId, clientId),
          eq(schema.oauthClients.isActive, true),
        ),
      )
      .limit(1);

    if (!client) {
      throw new UnauthorizedException('Invalid client');
    }

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
            eq(schema.customerIdentities.externalUserId, normalizedUserId),
          ),
        )
        .limit(1);

    const existing = await findExisting();

    if (existing[0]) {
      return this.ensureActive(existing[0].customer);
    }

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.customers)
        .values({ status: 'active' })
        .returning();

      if (!created) {
        throw new Error('Customer creation failed');
      }

      const inserted = await tx
        .insert(schema.customerIdentities)
        .values({
          customerId: created.id,
          oauthClientId: client.id,
          externalUserId: normalizedUserId,
        })
        .onConflictDoNothing({
          target: [
            schema.customerIdentities.oauthClientId,
            schema.customerIdentities.externalUserId,
          ],
        })
        .returning();

      if (inserted.length > 0) {
        return created;
      }

      await tx
        .delete(schema.customers)
        .where(eq(schema.customers.id, created.id));

      const winner = await tx
        .select({ customer: schema.customers })
        .from(schema.customerIdentities)
        .innerJoin(
          schema.customers,
          eq(schema.customers.id, schema.customerIdentities.customerId),
        )
        .where(
          and(
            eq(schema.customerIdentities.oauthClientId, client.id),
            eq(schema.customerIdentities.externalUserId, normalizedUserId),
          ),
        )
        .limit(1);

      if (!winner[0]) {
        throw new Error('Customer identity creation failed');
      }

      return this.ensureActive(winner[0].customer);
    });
  }

  private ensureActive(customer: Customer): Customer {
    if (customer.status !== 'active') {
      throw new ForbiddenException('Customer is inactive');
    }

    return customer;
  }
}