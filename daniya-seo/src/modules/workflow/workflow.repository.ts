import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, gte, lt, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';

import type * as schema from '../../infrastructure/database/schema';

import {
  pages,
  pageCycleSlots,
  customerPlanCycles,
  scans,
  scanEngineRuns,
  idempotencyRecords,
  outboxEvents,
} from '../../infrastructure/database/schema';

type Database = NodePgDatabase<typeof schema>;

export type DbTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];

export type ScanEngineType =
  (typeof schema.scanEngineTypeEnum.enumValues)[number];

@Injectable()
export class WorkflowRepository {
  // --------------------------------------------------
  // Idempotency
  // --------------------------------------------------

  async lockIdempotencyKey(
    customerId: string,
    idempotencyKey: string,
    tx: DbTransaction,
  ): Promise<void> {
    const lockKey = `${customerId}:${idempotencyKey}`;

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(
        hashtextextended(${lockKey}, 0)
      )`,
    );
  }

  async findIdempotencyRecord(
    customerId: string,
    idempotencyKey: string,
    tx: DbTransaction,
  ) {
    const [record] = await tx
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.customerId, customerId),
          eq(idempotencyRecords.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    return record ?? null;
  }

  async createIdempotencyRecord(
    input: typeof idempotencyRecords.$inferInsert,
    tx: DbTransaction,
  ) {
    const [record] = await tx
      .insert(idempotencyRecords)
      .values(input)
      .returning();

    return record;
  }

  // --------------------------------------------------
  // Pages
  // --------------------------------------------------

  async findPage(customerId: string, normalizedUrl: string, tx: DbTransaction) {
    const [page] = await tx
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.customerId, customerId),
          eq(pages.normalizedUrl, normalizedUrl),
        ),
      )
      .limit(1);

    return page ?? null;
  }

  async findOrCreatePage(
    customerId: string,
    normalizedUrl: string,
    tx: DbTransaction,
  ) {
    const [createdPage] = await tx
      .insert(pages)
      .values({
        customerId,
        normalizedUrl,
      })
      .onConflictDoNothing({
        target: [pages.customerId, pages.normalizedUrl],
      })
      .returning();

    if (createdPage) {
      return createdPage;
    }

    const existingPage = await this.findPage(customerId, normalizedUrl, tx);

    if (!existingPage) {
      throw new Error('Unable to resolve page.');
    }

    return existingPage;
  }

  // --------------------------------------------------
  // Plan cycle locking
  // --------------------------------------------------

  async lockPlanCycle(cycleId: string, tx: DbTransaction) {
    const [cycle] = await tx
      .select({
        id: customerPlanCycles.id,
      })
      .from(customerPlanCycles)
      .where(eq(customerPlanCycles.id, cycleId))
      .for('update')
      .limit(1);

    return cycle ?? null;
  }

  // --------------------------------------------------
  // Page cycle slots
  // --------------------------------------------------

  async findPageCycleSlot(pageId: string, cycleId: string, tx: DbTransaction) {
    const [slot] = await tx
      .select()
      .from(pageCycleSlots)
      .where(
        and(
          eq(pageCycleSlots.pageId, pageId),
          eq(pageCycleSlots.cycleId, cycleId),
        ),
      )
      .for('update')
      .limit(1);

    return slot ?? null;
  }

  async createPageCycleSlot(
    pageId: string,
    cycleId: string,
    tx: DbTransaction,
  ) {
    const [slot] = await tx
      .insert(pageCycleSlots)
      .values({
        pageId,
        cycleId,
        status: 'RESERVED',
      })
      .returning();

    return slot;
  }

  async reReservePageCycleSlot(slotId: string, tx: DbTransaction) {
    const [slot] = await tx
      .update(pageCycleSlots)
      .set({
        status: 'RESERVED',
        reservedAt: new Date(),
        consumedAt: null,
        releasedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pageCycleSlots.id, slotId),
          eq(pageCycleSlots.status, 'RELEASED'),
        ),
      )
      .returning();

    return slot ?? null;
  }

  async consumePageCycleSlot(
    slotId: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const [slot] = await tx
      .update(pageCycleSlots)
      .set({
        status: 'CONSUMED',
        consumedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pageCycleSlots.id, slotId),
          eq(pageCycleSlots.status, 'RESERVED'),
        ),
      )
      .returning({
        id: pageCycleSlots.id,
      });

    return Boolean(slot);
  }

  async releasePageCycleSlot(
    slotId: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const [slot] = await tx
      .update(pageCycleSlots)
      .set({
        status: 'RELEASED',
        releasedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pageCycleSlots.id, slotId),
          eq(pageCycleSlots.status, 'RESERVED'),
        ),
      )
      .returning({
        id: pageCycleSlots.id,
      });

    return Boolean(slot);
  }

  // --------------------------------------------------
  // Scans
  // --------------------------------------------------

  async createScan(input: typeof scans.$inferInsert, tx: DbTransaction) {
    const [scan] = await tx.insert(scans).values(input).returning();

    return scan;
  }

  async findScanById(scanId: string, tx: DbTransaction) {
    const [scan] = await tx
      .select()
      .from(scans)
      .where(eq(scans.id, scanId))
      .limit(1);

    return scan ?? null;
  }

  async findScanByIdForUpdate(scanId: string, tx: DbTransaction) {
    const [scan] = await tx
      .select()
      .from(scans)
      .where(eq(scans.id, scanId))
      .limit(1)
      .for('update');

    return scan ?? null;
  }

  async getNextScanAttemptNo(
    slotId: string,
    tx: DbTransaction,
  ): Promise<number> {
    const [result] = await tx
      .select({
        maxAttemptNo: sql<number>`
          COALESCE(MAX(${scans.attemptNo}), 0)::int
        `,
      })
      .from(scans)
      .where(eq(scans.slotId, slotId));

    return (result?.maxAttemptNo ?? 0) + 1;
  }

  async markScanRunning(scanId: string, tx: DbTransaction): Promise<boolean> {
    const now = new Date();

    const [scan] = await tx
      .update(scans)
      .set({
        status: 'running',
        startedAt: now,
        updatedAt: now,
      })
      .where(and(eq(scans.id, scanId), eq(scans.status, 'queued')))
      .returning({
        id: scans.id,
      });

    return Boolean(scan);
  }

  async markScanCompleted(scanId: string, tx: DbTransaction): Promise<boolean> {
    const now = new Date();

    const [scan] = await tx
      .update(scans)
      .set({
        status: 'completed',
        completedAt: now,
        failureCode: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(and(eq(scans.id, scanId), eq(scans.status, 'running')))
      .returning({
        id: scans.id,
      });

    return Boolean(scan);
  }

  async markScanFailed(
    scanId: string,
    errorCode: string,
    errorMessage: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const now = new Date();

    const [scan] = await tx
      .update(scans)
      .set({
        status: 'failed',
        completedAt: now,
        failureCode: errorCode.slice(0, 100),
        failureMessage: errorMessage,
        updatedAt: now,
      })
      .where(and(eq(scans.id, scanId), eq(scans.status, 'running')))
      .returning({
        id: scans.id,
      });

    return Boolean(scan);
  }

  // --------------------------------------------------
  // Scan engine runs
  // --------------------------------------------------

  async createScanEngineRuns(
    scanId: string,
    engineTypes: ScanEngineType[],
    tx: DbTransaction,
  ) {
    if (engineTypes.length === 0) {
      return [];
    }

    return tx
      .insert(scanEngineRuns)
      .values(
        engineTypes.map((engineType) => ({
          scanId,
          engineType,
        })),
      )
      .returning();
  }

  async findScanEngineRuns(scanId: string, tx: DbTransaction) {
    return tx
      .select()
      .from(scanEngineRuns)
      .where(eq(scanEngineRuns.scanId, scanId))
      .orderBy(asc(scanEngineRuns.createdAt));
  }

  async findScanEngineRun(
    scanId: string,
    engineType: ScanEngineType,
    tx: DbTransaction,
  ) {
    const [run] = await tx
      .select()
      .from(scanEngineRuns)
      .where(
        and(
          eq(scanEngineRuns.scanId, scanId),
          eq(scanEngineRuns.engineType, engineType),
        ),
      )
      .limit(1);

    return run ?? null;
  }

  async claimScanEngineRun(
    input: {
      scanId: string;
      engineType: ScanEngineType;
      maxAttempts: number;
      leaseDurationMs: number;
    },
    tx: DbTransaction,
  ) {
    if (
      !Number.isInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      !Number.isInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < 1_000
    ) {
      throw new Error('Invalid engine claim configuration.');
    }

    const now = new Date();
    const lockToken = randomUUID();

    const [run] = await tx
      .update(scanEngineRuns)
      .set({
        status: 'running',
        attempts: sql`${scanEngineRuns.attempts} + 1`,
        startedAt: now,
        completedAt: null,
        lockToken,
        leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs),
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(scanEngineRuns.scanId, input.scanId),
          eq(scanEngineRuns.engineType, input.engineType),
          lt(scanEngineRuns.attempts, input.maxAttempts),
          or(
            eq(scanEngineRuns.status, 'queued'),
            eq(scanEngineRuns.status, 'failed'),
            and(
              eq(scanEngineRuns.status, 'running'),
              lte(scanEngineRuns.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .returning();

    return run ?? null;
  }

  async renewScanEngineRunLease(
    runId: string,
    lockToken: string,
    leaseDurationMs: number,
    tx: DbTransaction,
  ): Promise<boolean> {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
      throw new Error('Invalid engine lease duration.');
    }

    const now = new Date();

    const [run] = await tx
      .update(scanEngineRuns)
      .set({
        leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
        updatedAt: now,
      })
      .where(
        and(
          eq(scanEngineRuns.id, runId),
          eq(scanEngineRuns.status, 'running'),
          eq(scanEngineRuns.lockToken, lockToken),
          gt(scanEngineRuns.leaseExpiresAt, now),
        ),
      )
      .returning({
        id: scanEngineRuns.id,
      });

    return Boolean(run);
  }

  async markScanEngineRunSucceeded(
    runId: string,
    lockToken: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const now = new Date();

    const [run] = await tx
      .update(scanEngineRuns)
      .set({
        status: 'completed',
        completedAt: now,
        lockToken: null,
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(scanEngineRuns.id, runId),
          eq(scanEngineRuns.status, 'running'),
          eq(scanEngineRuns.lockToken, lockToken),
          gt(scanEngineRuns.leaseExpiresAt, now),
        ),
      )
      .returning({
        id: scanEngineRuns.id,
      });

    return Boolean(run);
  }

  async markScanEngineRunFailed(
    runId: string,
    lockToken: string,
    errorCode: string,
    errorMessage: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const now = new Date();

    const [run] = await tx
      .update(scanEngineRuns)
      .set({
        status: 'failed',
        completedAt: now,
        lockToken: null,
        leaseExpiresAt: null,
        errorCode: errorCode.slice(0, 100),
        errorMessage: errorMessage.slice(0, 2_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(scanEngineRuns.id, runId),
          eq(scanEngineRuns.status, 'running'),
          eq(scanEngineRuns.lockToken, lockToken),
          gt(scanEngineRuns.leaseExpiresAt, now),
        ),
      )
      .returning({
        id: scanEngineRuns.id,
      });

    return Boolean(run);
  }

  async failExpiredEngineRun(
    runId: string,
    maxAttempts: number,
    tx: DbTransaction,
  ): Promise<boolean> {
    const now = new Date();

    const [run] = await tx
      .update(scanEngineRuns)
      .set({
        status: 'failed',
        completedAt: now,
        lockToken: null,
        leaseExpiresAt: null,
        errorCode: 'ENGINE_ATTEMPTS_EXHAUSTED',
        errorMessage: 'Engine execution lease expired after maximum attempts.',
        updatedAt: now,
      })
      .where(
        and(
          eq(scanEngineRuns.id, runId),
          eq(scanEngineRuns.status, 'running'),
          lte(scanEngineRuns.leaseExpiresAt, now),
          gte(scanEngineRuns.attempts, maxAttempts),
        ),
      )
      .returning({
        id: scanEngineRuns.id,
      });

    return Boolean(run);
  }

  // --------------------------------------------------
  // Outbox
  // --------------------------------------------------

  async createOutboxEvent(scanId: string, tx: DbTransaction) {
    const [event] = await tx
      .insert(outboxEvents)
      .values({
        scanId,
        eventType: 'scan.requested',
        payload: {
          scanId,
        },
      })
      .returning();

    return event;
  }

  async claimOutboxEvents(limit: number, staleBefore: Date, tx: DbTransaction) {
    const now = new Date();

    const events = await tx
      .select({
        id: outboxEvents.id,
      })
      .from(outboxEvents)
      .where(
        or(
          and(
            eq(outboxEvents.status, 'pending'),
            lte(outboxEvents.nextAttemptAt, now),
          ),
          and(
            eq(outboxEvents.status, 'processing'),
            lt(outboxEvents.lockedAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(outboxEvents.createdAt))
      .limit(limit)
      .for('update', {
        skipLocked: true,
      });

    const claimedEvents = [];

    for (const event of events) {
      const [claimed] = await tx
        .update(outboxEvents)
        .set({
          status: 'processing',
          lockedAt: now,
          lockToken: randomUUID(),
          attempts: sql`${outboxEvents.attempts} + 1`,
          updatedAt: now,
        })
        .where(eq(outboxEvents.id, event.id))
        .returning();

      if (claimed) {
        claimedEvents.push(claimed);
      }
    }

    return claimedEvents;
  }

  async markOutboxPublished(
    eventId: string,
    lockToken: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const now = new Date();

    const [event] = await tx
      .update(outboxEvents)
      .set({
        status: 'published',
        publishedAt: now,
        lockedAt: null,
        lockToken: null,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(outboxEvents.id, eventId),
          eq(outboxEvents.status, 'processing'),
          eq(outboxEvents.lockToken, lockToken),
        ),
      )
      .returning({
        id: outboxEvents.id,
      });

    return Boolean(event);
  }

  async retryOutboxEvent(
    eventId: string,
    lockToken: string,
    status: 'pending' | 'failed',
    nextAttemptAt: Date,
    errorMessage: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const now = new Date();

    const [event] = await tx
      .update(outboxEvents)
      .set({
        status,
        nextAttemptAt,
        lockedAt: null,
        lockToken: null,
        lastError: errorMessage.slice(0, 2_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(outboxEvents.id, eventId),
          eq(outboxEvents.status, 'processing'),
          eq(outboxEvents.lockToken, lockToken),
        ),
      )
      .returning({
        id: outboxEvents.id,
      });

    return Boolean(event);
  }

  async findScanByIdForCustomer(
    scanId: string,
    customerId: string,
    tx: DbTransaction,
  ) {
    const [scan] = await tx
      .select()
      .from(scans)
      .where(and(eq(scans.id, scanId), eq(scans.customerId, customerId)))
      .limit(1);

    return scan ?? null;
  }
}
