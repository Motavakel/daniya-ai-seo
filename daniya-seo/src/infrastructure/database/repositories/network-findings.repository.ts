import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DrizzleService } from '../drizzle.service';
import { networkFindings, networkRuns } from '../schema';

export type NetworkFindingInsert = Omit<
  typeof networkFindings.$inferInsert,
  'id' | 'createdAt' | 'networkRunId'
>;
export type NetworkFindingRow = typeof networkFindings.$inferSelect;

@Injectable()
export class NetworkFindingsRepository {
  constructor(private readonly database: DrizzleService) {}

  async replaceForRun(networkRunId: string, findings: NetworkFindingInsert[]): Promise<NetworkFindingRow[]> {
    return this.database.db.transaction(async (tx) => {
      const run = await tx.query.networkRuns.findFirst({
        where: eq(networkRuns.id, networkRunId),
      });
      if (!run) throw new Error('NETWORK_RUN_NOT_FOUND');

      await tx.delete(networkFindings).where(eq(networkFindings.networkRunId, networkRunId));
      if (findings.length === 0) return [];

      const rows: NetworkFindingRow[] = [];
      const batchSize = 250;
      for (let offset = 0; offset < findings.length; offset += batchSize) {
        const batch = findings.slice(offset, offset + batchSize);
        const inserted = await tx
          .insert(networkFindings)
          .values(batch.map((finding) => ({ ...finding, networkRunId })))
          .returning();
        rows.push(...inserted);
      }
      return rows;
    });
  }

  async listByScanId(scanId: string): Promise<NetworkFindingRow[]> {
    const runs = await this.database.db
      .select({ id: networkRuns.id })
      .from(networkRuns)
      .where(eq(networkRuns.scanId, scanId));
    if (runs.length === 0) return [];

    return this.database.db
      .select()
      .from(networkFindings)
      .where(inArray(networkFindings.networkRunId, runs.map((run) => run.id)))
      .orderBy(asc(networkFindings.createdAt));
  }

  async listByNetworkRunId(networkRunId: string): Promise<NetworkFindingRow[]> {
    return this.database.db
      .select()
      .from(networkFindings)
      .where(eq(networkFindings.networkRunId, networkRunId))
      .orderBy(asc(networkFindings.createdAt));
  }
}
