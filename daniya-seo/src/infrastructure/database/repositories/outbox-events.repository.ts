import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { DrizzleService } from '../drizzle.service';
import { outboxEvents } from '../schema';

type OutboxRow = typeof outboxEvents.$inferSelect;

export interface ClaimOutboxBatchInput {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  now?: Date;
}

export interface ReleaseOutboxEventInput {
  eventId: string;
  workerId: string;
  /** A pre-sanitized operational message; never pass raw headers, URLs, or secrets. */
  error: string;
  retryAt: Date;
}

@Injectable()
export class OutboxEventsRepository {
  constructor(private readonly database: DrizzleService) {}

  /**
   * Claims pending or lease-expired events using FOR UPDATE SKIP LOCKED.
   * Attempts are incremented before publishing, so a crashed publisher is
   * still counted as an attempt and can eventually be dead-lettered.
   */
  async claimBatch(input: ClaimOutboxBatchInput): Promise<OutboxRow[]> {
    const now = input.now ?? new Date();
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 60, 10), 900);
    const staleBefore = new Date(now.getTime() - leaseSeconds * 1_000);

    return this.database.db.transaction(async (tx) => {
      // A worker may have died during its final permitted attempt. Do not leave
      // that event in processing forever after its lease expires.
      await tx
        .update(outboxEvents)
        .set({
          status: 'dead_lettered',
          lockedAt: null,
          lockedBy: null,
          lastError: 'Publisher lease expired after the maximum number of attempts.',
          updatedAt: now,
        })
        .where(
          and(
            eq(outboxEvents.status, 'processing'),
            lte(outboxEvents.lockedAt, staleBefore),
            sql`${outboxEvents.attempts} >= ${outboxEvents.maxAttempts}`,
          ),
        );

      const claimable = or(
        and(
          eq(outboxEvents.status, 'pending'),
          lte(outboxEvents.availableAt, now),
          sql`${outboxEvents.attempts} < ${outboxEvents.maxAttempts}`,
        ),
        and(
          eq(outboxEvents.status, 'processing'),
          lte(outboxEvents.lockedAt, staleBefore),
          sql`${outboxEvents.attempts} < ${outboxEvents.maxAttempts}`,
        ),
      );

      const candidates = await tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(claimable)
        .orderBy(asc(outboxEvents.availableAt), asc(outboxEvents.createdAt))
        .limit(limit)
        .for('update', { skipLocked: true });

      if (candidates.length === 0) return [];

      const ids = candidates.map((candidate) => candidate.id);
      return tx
        .update(outboxEvents)
        .set({
          status: 'processing',
          lockedAt: now,
          lockedBy: input.workerId,
          attempts: sql`${outboxEvents.attempts} + 1`,
          updatedAt: now,
        })
        .where(inArray(outboxEvents.id, ids))
        .returning();
    });
  }

  async renewLease(input: {
    eventId: string;
    workerId: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const rows = await this.database.db
      .update(outboxEvents)
      .set({ lockedAt: now, updatedAt: now })
      .where(
        and(
          eq(outboxEvents.id, input.eventId),
          eq(outboxEvents.status, 'processing'),
          eq(outboxEvents.lockedBy, input.workerId),
        ),
      )
      .returning({ id: outboxEvents.id });

    return rows.length > 0;
  }

  async markPublished(input: {
    eventId: string;
    workerId: string;
    publishedAt?: Date;
  }): Promise<boolean> {
    const publishedAt = input.publishedAt ?? new Date();
    const rows = await this.database.db
      .update(outboxEvents)
      .set({
        status: 'published',
        publishedAt,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        updatedAt: publishedAt,
      })
      .where(
        and(
          eq(outboxEvents.id, input.eventId),
          eq(outboxEvents.status, 'processing'),
          eq(outboxEvents.lockedBy, input.workerId),
        ),
      )
      .returning({ id: outboxEvents.id });

    return rows.length > 0;
  }

  async releaseForRetry(
    input: ReleaseOutboxEventInput,
  ): Promise<'pending' | 'dead_lettered' | undefined> {
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.id, input.eventId),
            eq(outboxEvents.status, 'processing'),
            eq(outboxEvents.lockedBy, input.workerId),
          ),
        )
        .limit(1)
        .for('update');

      const event = rows[0];
      if (!event) return undefined;

      const nextStatus =
        event.attempts >= event.maxAttempts ? 'dead_lettered' : 'pending';
      const now = new Date();

      await tx
        .update(outboxEvents)
        .set({
          status: nextStatus,
          availableAt: input.retryAt,
          lockedAt: null,
          lockedBy: null,
          lastError: input.error.slice(0, 2_000),
          updatedAt: now,
        })
        .where(eq(outboxEvents.id, input.eventId));

      return nextStatus;
    });
  }

  findById(eventId: string): Promise<OutboxRow | undefined> {
    return this.database.db.query.outboxEvents.findFirst({
      where: eq(outboxEvents.id, eventId),
    });
  }
}
