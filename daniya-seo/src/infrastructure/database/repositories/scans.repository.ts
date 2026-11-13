import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DrizzleService } from '../drizzle.service';
import { outboxEvents, scans } from '../schema';
import type { JsonObject } from '../schema/schema.types';

type ScanProfile = typeof scans.$inferSelect.profile;
type ScanStatus = typeof scans.$inferSelect.status;
type ScanRow = typeof scans.$inferSelect;

export interface CreateScanRecordInput {
  callerRef: string;
  idempotencyKey?: string | null;
  targetUrl: string;
  hostname: string;
  profile: ScanProfile;
  requestOptions?: JsonObject;
  expiresAt?: Date | null;
}

export interface CreateScanRecordResult {
  scan: ScanRow;
  created: boolean;
}

export interface UpdateScanStatusInput {
  scanId: string;
  expectedStatuses: ScanStatus[];
  status: ScanStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

@Injectable()
export class ScansRepository {
  constructor(private readonly database: DrizzleService) {}

  /**
   * Creates the scan and its first Lighthouse outbox event in one transaction.
   * The profile must already be resolved from trusted entitlement data.
   */
  async createWithInitialOutbox(
    input: CreateScanRecordInput,
  ): Promise<CreateScanRecordResult> {
    const strategy =
      input.profile === 'basic'
        ? ('lighthouse_only' as const)
        : ('lighthouse_then_network' as const);

    return this.database.db.transaction(async (tx) => {
      const insertedRows = await tx
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

      const inserted = insertedRows[0];

      if (inserted) {
        await tx.insert(outboxEvents).values({
          scanId: inserted.id,
          eventType: 'scan.lighthouse.requested',
          eventKey: `scan:${inserted.id}:lighthouse:attempt:1`,
          payload: {
            scanId: inserted.id,
            engine: 'lighthouse',
            profile: inserted.profile,
            strategy: inserted.strategy,
          },
          status: 'pending',
          maxAttempts: 10,
        });

        return { scan: inserted, created: true };
      }

      // A conflict is expected only when the caller reuses an idempotency key.
      if (input.idempotencyKey) {
        const existingRows = await tx
          .select()
          .from(scans)
          .where(
            and(
              eq(scans.callerRef, input.callerRef),
              eq(scans.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);

        const existing = existingRows[0];
        if (existing) return { scan: existing, created: false };
      }

      throw new Error(
        'Scan creation failed because of an unexpected database constraint conflict.',
      );
    });
  }

  findById(scanId: string): Promise<ScanRow | undefined> {
    return this.database.db.query.scans.findFirst({
      where: eq(scans.id, scanId),
    });
  }

  findByIdAndCallerRef(
    scanId: string,
    callerRef: string,
  ): Promise<ScanRow | undefined> {
    return this.database.db.query.scans.findFirst({
      where: and(eq(scans.id, scanId), eq(scans.callerRef, callerRef)),
    });
  }

  async listByCaller(input: {
    callerRef: string;
    limit?: number;
    offset?: number;
  }): Promise<ScanRow[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const offset = Math.max(input.offset ?? 0, 0);

    return this.database.db
      .select()
      .from(scans)
      .where(eq(scans.callerRef, input.callerRef))
      .orderBy(desc(scans.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /**
   * Optimistic status update. Returns undefined when the current status is not
   * one of expectedStatuses, allowing the caller to detect a stale transition.
   */
  async updateStatusIfCurrent(
    input: UpdateScanStatusInput,
  ): Promise<ScanRow | undefined> {
    if (input.expectedStatuses.length === 0) return undefined;

    const values: Partial<typeof scans.$inferInsert> = {
      status: input.status,
      updatedAt: new Date(),
    };

    if (input.errorCode !== undefined) values.errorCode = input.errorCode;
    if (input.errorMessage !== undefined) {
      values.errorMessage = input.errorMessage;
    }
    if (input.startedAt !== undefined) values.startedAt = input.startedAt;
    if (input.completedAt !== undefined) values.completedAt = input.completedAt;

    const rows = await this.database.db
      .update(scans)
      .set(values)
      .where(
        and(
          eq(scans.id, input.scanId),
          inArray(scans.status, input.expectedStatuses),
        ),
      )
      .returning();

    return rows[0];
  }
}
