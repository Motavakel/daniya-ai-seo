import { Injectable } from '@nestjs/common';
import { and, eq, max } from 'drizzle-orm';
import { DrizzleService } from '../drizzle.service';
import { outboxEvents, scanEngineRuns, scans } from '../schema';
import type { JsonObject } from '../schema/schema.types';

export type ScanProfile = typeof scans.$inferInsert.profile;
export type EngineName = typeof scanEngineRuns.$inferInsert.engine;
export type ScanRow = typeof scans.$inferSelect;

export interface CreateWorkflowScanInput {
  callerRef: string;
  idempotencyKey?: string | null;
  targetUrl: string;
  hostname: string;
  profile: ScanProfile;
  requestOptions?: JsonObject;
  expiresAt?: Date | null;
}

@Injectable()
export class ScanWorkflowRepository {
  constructor(private readonly database: DrizzleService) {}

  async createScan(input: CreateWorkflowScanInput): Promise<{ scan: ScanRow; created: boolean }> {
    return this.database.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.query.scans.findFirst({
          where: and(
            eq(scans.callerRef, input.callerRef),
            eq(scans.idempotencyKey, input.idempotencyKey),
          ),
        });
        if (existing) return { scan: existing, created: false };
      }

      const strategy = input.profile === 'basic' ? 'lighthouse_only' : 'lighthouse_then_network';
      const scanRows = await tx
        .insert(scans)
        .values({
          callerRef: input.callerRef,
          idempotencyKey: input.idempotencyKey ?? null,
          targetUrl: input.targetUrl,
          hostname: input.hostname,
          profile: input.profile,
          strategy,
          status: 'queued',
          requestOptions: input.requestOptions ?? {},
          expiresAt: input.expiresAt ?? null,
        })
        .onConflictDoNothing()
        .returning();
      const scan = scanRows[0];
      if (!scan) {
        if (input.idempotencyKey) {
          const existing = await tx.query.scans.findFirst({
            where: and(
              eq(scans.callerRef, input.callerRef),
              eq(scans.idempotencyKey, input.idempotencyKey),
            ),
          });
          if (existing) return { scan: existing, created: false };
        }
        throw new Error('SCAN_CREATE_CONSTRAINT_CONFLICT');
      }

      const [engineRun] = await tx
        .insert(scanEngineRuns)
        .values({
          scanId: scan.id,
          engine: 'lighthouse',
          attempt: 1,
          status: 'queued',
          executionContext: { profile: scan.profile, strategy: scan.strategy },
        })
        .returning();
      if (!engineRun) throw new Error('INITIAL_ENGINE_RUN_CREATE_FAILED');

      await tx.insert(outboxEvents).values({
        scanId: scan.id,
        eventType: 'scan.lighthouse.requested',
        eventKey: `engine-run:${engineRun.id}`,
        payload: { scanId: scan.id, engineRunId: engineRun.id, engine: 'lighthouse' },
        status: 'pending',
        maxAttempts: 10,
      });

      return { scan, created: true };
    });
  }

  async enqueueNetworkAfterLighthouse(scanId: string): Promise<{ queued: boolean; engineRunId?: string }> {
    return this.database.db.transaction(async (tx) => {
      const [scan] = await tx
        .select()
        .from(scans)
        .where(eq(scans.id, scanId))
        .for('update');
      if (!scan) throw new Error('SCAN_NOT_FOUND');
      if (scan.profile !== 'detailed') return { queued: false };

      // A duplicate Lighthouse completion event must never move an already
      // completed scan back to network_queued or create another Network run.
      if (scan.status === 'completed' || scan.status === 'completed_with_warnings' || scan.status === 'failed') {
        return { queued: false };
      }

      const existing = await tx.query.scanEngineRuns.findFirst({
        where: and(eq(scanEngineRuns.scanId, scanId), eq(scanEngineRuns.engine, 'network')),
        orderBy: (table, { desc }) => [desc(table.attempt)],
      });
      if (existing) {
        if (existing.status === 'queued' && scan.status !== 'network_queued') {
          await tx
            .update(scans)
            .set({ status: 'network_queued', updatedAt: new Date() })
            .where(eq(scans.id, scanId));
        }
        return {
          queued: existing.status === 'queued' || existing.status === 'running',
          engineRunId: existing.id,
        };
      }

      const [engineRun] = await tx
        .insert(scanEngineRuns)
        .values({
          scanId,
          engine: 'network',
          attempt: 1,
          status: 'queued',
          executionContext: { profile: scan.profile, strategy: scan.strategy },
        })
        .returning();
      if (!engineRun) throw new Error('NETWORK_ENGINE_RUN_CREATE_FAILED');

      await tx
        .update(scans)
        .set({ status: 'network_queued', updatedAt: new Date() })
        .where(eq(scans.id, scanId));

      await tx.insert(outboxEvents).values({
        scanId,
        eventType: 'scan.network.requested',
        eventKey: `engine-run:${engineRun.id}`,
        payload: { scanId, engineRunId: engineRun.id, engine: 'network' },
        status: 'pending',
        maxAttempts: 10,
      });

      return { queued: true, engineRunId: engineRun.id };
    });
  }


  async markOutboxDeliveryFailed(input: {
    scanId: string;
    engineRunId: string;
    engine: 'lighthouse' | 'network';
    safeErrorCode: string;
  }): Promise<'failed' | 'completed_with_warnings' | undefined> {
    return this.database.db.transaction(async (tx) => {
      const [scan] = await tx
        .select()
        .from(scans)
        .where(eq(scans.id, input.scanId))
        .for('update');
      if (!scan) return undefined;
      if (['completed', 'completed_with_warnings', 'failed', 'cancelled', 'expired'].includes(scan.status)) {
        return undefined;
      }

      const [engineRun] = await tx
        .select()
        .from(scanEngineRuns)
        .where(and(
          eq(scanEngineRuns.id, input.engineRunId),
          eq(scanEngineRuns.scanId, input.scanId),
          eq(scanEngineRuns.engine, input.engine),
        ))
        .limit(1);
      if (!engineRun) return undefined;

      if (engineRun.status === 'queued') {
        await tx
          .update(scanEngineRuns)
          .set({
            status: 'failed',
            finishedAt: new Date(),
            errorCode: input.safeErrorCode.slice(0, 64),
            errorMessage: 'Queue delivery failed before engine execution.',
            updatedAt: new Date(),
          })
          .where(eq(scanEngineRuns.id, engineRun.id));
      }

      const finalStatus = input.engine === 'network'
        ? 'completed_with_warnings'
        : 'failed';
      await tx
        .update(scans)
        .set({
          status: finalStatus,
          completedAt: new Date(),
          errorCode: input.safeErrorCode.slice(0, 64),
          errorMessage: 'The scan engine could not be delivered to a Worker.',
          updatedAt: new Date(),
        })
        .where(eq(scans.id, scan.id));
      return finalStatus;
    });
  }

  async setScanRunning(scanId: string): Promise<void> {
    await this.database.db
      .update(scans)
      .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(scans.id, scanId), eq(scans.status, 'queued')));
    await this.database.db
      .update(scans)
      .set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(scans.id, scanId), eq(scans.status, 'network_queued')));
  }

  async scheduleEngineRetry(input: {
    scanId: string;
    engineRunId: string;
    maxAttempts: number;
    safeErrorCode: string;
  }): Promise<{ retryScheduled: boolean; finalStatus?: 'failed' | 'completed_with_warnings'; nextEngineRunId?: string }> {
    return this.database.db.transaction(async (tx) => {
      const [scan] = await tx
        .select()
        .from(scans)
        .where(eq(scans.id, input.scanId))
        .for('update');
      if (!scan) throw new Error('SCAN_NOT_FOUND');

      const [currentRun] = await tx
        .select()
        .from(scanEngineRuns)
        .where(and(
          eq(scanEngineRuns.id, input.engineRunId),
          eq(scanEngineRuns.scanId, input.scanId),
        ))
        .limit(1);
      if (!currentRun) throw new Error('ENGINE_RUN_NOT_FOUND');

      const [attemptResult] = await tx
        .select({ lastAttempt: max(scanEngineRuns.attempt) })
        .from(scanEngineRuns)
        .where(and(
          eq(scanEngineRuns.scanId, input.scanId),
          eq(scanEngineRuns.engine, currentRun.engine),
        ));
      const lastAttempt = attemptResult?.lastAttempt ?? currentRun.attempt;

      // Duplicate queue delivery: another handler may already have created the retry.
      if (lastAttempt > currentRun.attempt) {
        const next = await tx.query.scanEngineRuns.findFirst({
          where: and(
            eq(scanEngineRuns.scanId, input.scanId),
            eq(scanEngineRuns.engine, currentRun.engine),
          ),
          orderBy: (table, { desc }) => [desc(table.attempt)],
        });
        return { retryScheduled: true, nextEngineRunId: next?.id };
      }

      if (currentRun.status === 'queued' || currentRun.status === 'running') {
        await tx
          .update(scanEngineRuns)
          .set({
            status: 'failed',
            finishedAt: new Date(),
            errorCode: input.safeErrorCode.slice(0, 64),
            errorMessage: 'Engine attempt failed.',
            updatedAt: new Date(),
          })
          .where(eq(scanEngineRuns.id, currentRun.id));
      }

      if (currentRun.attempt < input.maxAttempts) {
        const nextAttempt = currentRun.attempt + 1;
        const [nextRun] = await tx
          .insert(scanEngineRuns)
          .values({
            scanId: scan.id,
            engine: currentRun.engine,
            attempt: nextAttempt,
            status: 'queued',
            executionContext: currentRun.executionContext,
          })
          .returning();
        if (!nextRun) throw new Error('ENGINE_RETRY_CREATE_FAILED');

        const eventType = currentRun.engine === 'lighthouse'
          ? 'scan.lighthouse.requested'
          : 'scan.network.requested';
        await tx.insert(outboxEvents).values({
          scanId: scan.id,
          eventType,
          eventKey: `engine-run:${nextRun.id}`,
          payload: { scanId: scan.id, engineRunId: nextRun.id, engine: currentRun.engine },
          status: 'pending',
          maxAttempts: 10,
        });

        await tx
          .update(scans)
          .set({
            status: currentRun.engine === 'lighthouse' ? 'queued' : 'network_queued',
            retryCount: scan.retryCount + 1,
            errorCode: input.safeErrorCode.slice(0, 64),
            errorMessage: null,
            updatedAt: new Date(),
          })
          .where(eq(scans.id, scan.id));

        return { retryScheduled: true, nextEngineRunId: nextRun.id };
      }

      const finalStatus = currentRun.engine === 'network'
        ? 'completed_with_warnings'
        : 'failed';
      await tx
        .update(scans)
        .set({
          status: finalStatus,
          errorCode: input.safeErrorCode.slice(0, 64),
          errorMessage: 'The requested scan engine could not complete.',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(scans.id, scan.id));

      return { retryScheduled: false, finalStatus };
    });
  }
}
