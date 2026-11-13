import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt } from 'drizzle-orm';
import { DrizzleService } from '../drizzle.service';
import { networkRequests, networkRuns, reportArtifacts } from '../schema';

export type CreateNetworkRunInput = Omit<typeof networkRuns.$inferInsert, 'id' | 'createdAt'>;
export type CreateNetworkRequestInput = Omit<
  typeof networkRequests.$inferInsert,
  'id' | 'networkRunId' | 'createdAt'
>;
export type CreateNetworkArtifactInput = Omit<
  typeof reportArtifacts.$inferInsert,
  'id' | 'createdAt'
>;
export type NetworkRunRow = typeof networkRuns.$inferSelect;
export type NetworkRequestRow = typeof networkRequests.$inferSelect;

export interface PersistNetworkCaptureInput {
  run: CreateNetworkRunInput;
  requests: CreateNetworkRequestInput[];
  artifacts: CreateNetworkArtifactInput[];
  batchSize?: number;
}

@Injectable()
export class NetworkCapturesRepository {
  constructor(private readonly database: DrizzleService) {}

  async persistCapture(input: PersistNetworkCaptureInput): Promise<{
    run: NetworkRunRow;
    persistedRequestCount: number;
    artifactCount: number;
    reusedExisting: boolean;
  }> {
    const batchSize = Math.min(Math.max(input.batchSize ?? 250, 1), 500);

    return this.database.db.transaction(async (tx) => {
      const existing = await tx.query.networkRuns.findFirst({
        where: eq(networkRuns.engineRunId, input.run.engineRunId),
      });
      if (existing) {
        const [requestCount] = await tx
          .select({ value: count() })
          .from(networkRequests)
          .where(eq(networkRequests.networkRunId, existing.id));
        return {
          run: existing,
          persistedRequestCount: requestCount?.value ?? 0,
          artifactCount: 0,
          reusedExisting: true,
        };
      }

      const runRows = await tx
        .insert(networkRuns)
        .values({ ...input.run, totalRequests: input.requests.length })
        .returning();
      const run = runRows[0];
      if (!run) throw new Error('NETWORK_RUN_INSERT_FAILED');

      for (let offset = 0; offset < input.requests.length; offset += batchSize) {
        const batch = input.requests.slice(offset, offset + batchSize);
        await tx.insert(networkRequests).values(
          batch.map((request) => ({ ...request, networkRunId: run.id })),
        );
      }

      if (input.artifacts.length > 0) {
        await tx.insert(reportArtifacts).values(
          input.artifacts.map((artifact) => ({ ...artifact, scanId: run.scanId, engineRunId: run.engineRunId })),
        );
      }

      return {
        run,
        persistedRequestCount: input.requests.length,
        artifactCount: input.artifacts.length,
        reusedExisting: false,
      };
    });
  }

  findRunById(networkRunId: string): Promise<NetworkRunRow | undefined> {
    return this.database.db.query.networkRuns.findFirst({
      where: eq(networkRuns.id, networkRunId),
    });
  }

  findRunByEngineRunId(engineRunId: string): Promise<NetworkRunRow | undefined> {
    return this.database.db.query.networkRuns.findFirst({
      where: eq(networkRuns.engineRunId, engineRunId),
    });
  }

  findLatestRunForScan(scanId: string): Promise<NetworkRunRow | undefined> {
    return this.database.db.query.networkRuns.findFirst({
      where: eq(networkRuns.scanId, scanId),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
  }

  async listRequests(input: {
    networkRunId: string;
    afterId?: number;
    limit?: number;
  }): Promise<NetworkRequestRow[]> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const whereClause = input.afterId !== undefined
      ? and(
          eq(networkRequests.networkRunId, input.networkRunId),
          gt(networkRequests.id, input.afterId),
        )
      : eq(networkRequests.networkRunId, input.networkRunId);

    return this.database.db
      .select()
      .from(networkRequests)
      .where(whereClause)
      .orderBy(asc(networkRequests.id))
      .limit(limit);
  }

  async listAllRequestsForDiagnostics(networkRunId: string, maxRows = 20_000): Promise<NetworkRequestRow[]> {
    const limit = Math.min(Math.max(maxRows, 1), 20_000);
    return this.database.db
      .select()
      .from(networkRequests)
      .where(eq(networkRequests.networkRunId, networkRunId))
      .orderBy(asc(networkRequests.id))
      .limit(limit);
  }

  async countRequests(networkRunId: string): Promise<number> {
    const [result] = await this.database.db
      .select({ value: count() })
      .from(networkRequests)
      .where(eq(networkRequests.networkRunId, networkRunId));
    return result?.value ?? 0;
  }
}
