import { Injectable } from '@nestjs/common';
import { and, desc, eq, max } from 'drizzle-orm';
import { DrizzleService } from '../drizzle.service';
import { scanEngineRuns, scans } from '../schema';
import type { JsonObject } from '../schema/schema.types';

type EngineType = typeof scanEngineRuns.$inferSelect.engine;
type EngineRunRow = typeof scanEngineRuns.$inferSelect;

export interface CreateEngineRunInput {
  scanId: string;
  engine: EngineType;
  engineVersion?: string | null;
  parserVersion?: string | null;
  executionContext?: JsonObject;
}

@Injectable()
export class ScanEngineRunsRepository {
  constructor(private readonly database: DrizzleService) {}

  /**
   * Locks the parent scan before calculating the next attempt. This prevents
   * two concurrent jobs from creating the same (scan, engine, attempt) tuple.
   */
  async createNextAttempt(
    input: CreateEngineRunInput,
  ): Promise<EngineRunRow | undefined> {
    return this.database.db.transaction(async (tx) => {
      const scanRows = await tx
        .select({ id: scans.id })
        .from(scans)
        .where(eq(scans.id, input.scanId))
        .for('update');

      if (!scanRows[0]) return undefined;

      const [attemptRow] = await tx
        .select({ lastAttempt: max(scanEngineRuns.attempt) })
        .from(scanEngineRuns)
        .where(
          and(
            eq(scanEngineRuns.scanId, input.scanId),
            eq(scanEngineRuns.engine, input.engine),
          ),
        );

      const attempt = (attemptRow?.lastAttempt ?? 0) + 1;
      const rows = await tx
        .insert(scanEngineRuns)
        .values({
          scanId: input.scanId,
          engine: input.engine,
          attempt,
          status: 'queued',
          engineVersion: input.engineVersion ?? null,
          parserVersion: input.parserVersion ?? null,
          executionContext: input.executionContext ?? {},
        })
        .returning();

      return rows[0];
    });
  }

  async findById(engineRunId: string): Promise<EngineRunRow | undefined> {
    return this.database.db.query.scanEngineRuns.findFirst({
      where: eq(scanEngineRuns.id, engineRunId),
    });
  }

  async findLatestForScan(
    scanId: string,
    engine: EngineType,
  ): Promise<EngineRunRow | undefined> {
    return this.database.db.query.scanEngineRuns.findFirst({
      where: and(
        eq(scanEngineRuns.scanId, scanId),
        eq(scanEngineRuns.engine, engine),
      ),
      orderBy: [desc(scanEngineRuns.attempt)],
    });
  }

  async markRunning(input: {
    engineRunId: string;
    workerId: string;
  }): Promise<EngineRunRow | undefined> {
    const rows = await this.database.db
      .update(scanEngineRuns)
      .set({
        status: 'running',
        workerId: input.workerId,
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scanEngineRuns.id, input.engineRunId),
          eq(scanEngineRuns.status, 'queued'),
        ),
      )
      .returning();

    return rows[0];
  }

  async markSucceeded(input: {
    engineRunId: string;
    durationMs?: string | null;
  }): Promise<EngineRunRow | undefined> {
    const rows = await this.database.db
      .update(scanEngineRuns)
      .set({
        status: 'succeeded',
        finishedAt: new Date(),
        durationMs: input.durationMs ?? null,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scanEngineRuns.id, input.engineRunId),
          eq(scanEngineRuns.status, 'running'),
        ),
      )
      .returning();

    return rows[0];
  }

  async markFailed(input: {
    engineRunId: string;
    errorCode: string;
    errorMessage?: string | null;
    durationMs?: string | null;
  }): Promise<EngineRunRow | undefined> {
    const rows = await this.database.db
      .update(scanEngineRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        durationMs: input.durationMs ?? null,
        errorCode: input.errorCode.slice(0, 64),
        errorMessage: input.errorMessage?.slice(0, 2_000) ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scanEngineRuns.id, input.engineRunId),
          eq(scanEngineRuns.status, 'running'),
        ),
      )
      .returning();

    return rows[0];
  }

  async markSkipped(
    engineRunId: string,
  ): Promise<EngineRunRow | undefined> {
    const rows = await this.database.db
      .update(scanEngineRuns)
      .set({
        status: 'skipped',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scanEngineRuns.id, engineRunId),
          eq(scanEngineRuns.status, 'queued'),
        ),
      )
      .returning();

    return rows[0];
  }
}
