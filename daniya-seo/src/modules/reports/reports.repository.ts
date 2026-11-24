import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  scans,
  pages,
  pageCycleSlots,
  scanEngineRuns,
  networkRuns,
  lighthouseRuns,
} from '../../infrastructure/database/schema';
import { reportArtifacts } from '../../infrastructure/database/schema/workflow/report-artifacts.schema';

@Injectable()
export class ReportsRepository {
  constructor(
    private readonly drizzle: DrizzleService,
  ) {}

  async findOwnedScan(
    scanId: string,
    customerId: string,
  ) {
    const [result] = await this.drizzle.db
      .select({
        scan: scans,
      })
      .from(scans)
      .innerJoin(
        pageCycleSlots,
        eq(pageCycleSlots.id, scans.slotId),
      )
      .innerJoin(
        pages,
        eq(pages.id, pageCycleSlots.pageId),
      )
      .where(
        and(
          eq(scans.id, scanId),
          eq(pages.customerId, customerId),
        ),
      )
      .limit(1);

    return result?.scan ?? null;
  }

  async findEngineRuns(scanId: string) {
    return this.drizzle.db
      .select({
        engineType: scanEngineRuns.engineType,
        status: scanEngineRuns.status,
        attempts: scanEngineRuns.attempts,
        startedAt: scanEngineRuns.startedAt,
        completedAt: scanEngineRuns.completedAt,
        errorCode: scanEngineRuns.errorCode,
      })
      .from(scanEngineRuns)
      .where(eq(scanEngineRuns.scanId, scanId));
  }

  async findLighthouseReport(scanId: string) {
    const [report] = await this.drizzle.db
      .select()
      .from(lighthouseRuns)
      .where(eq(lighthouseRuns.scanId, scanId))
      .limit(1);

    return report ?? null;
  }

  async findNetworkRun(scanId: string) {
    const [run] = await this.drizzle.db
      .select()
      .from(networkRuns)
      .where(eq(networkRuns.scanId, scanId))
      .limit(1);

    return run ?? null;
  }

  async findArtifacts(scanId: string) {
    return this.drizzle.db
      .select({
        id: reportArtifacts.id,
        artifactType: reportArtifacts.artifactType,
        mimeType: reportArtifacts.mimeType,
        sizeBytes: reportArtifacts.sizeBytes,
        createdAt: reportArtifacts.createdAt,
        expiresAt: reportArtifacts.expiresAt,
      })
      .from(reportArtifacts)
      .where(eq(reportArtifacts.scanId, scanId));
  }
}