import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import { ReportsRepository } from './reports.repository';

type ScanRecord = NonNullable<
  Awaited<
    ReturnType<ReportsRepository['findOwnedScan']>
  >
>;

@Injectable()
export class ReportsService {
  constructor(
    private readonly repository: ReportsRepository,
  ) {}

  async getScanReport(input: {
    scanId: string;
    customerId: string;
  }) {
    const scan = await this.repository.findOwnedScan(
      input.scanId,
      input.customerId,
    );

    if (!scan) {
      throw new NotFoundException('Report not found.');
    }

    if (
      scan.status === 'queued' ||
      scan.status === 'running'
    ) {
      throw new ConflictException(
        'Report is not ready yet.',
      );
    }

    const isPro = scan.planLevelAtRequest === 'pro';

    const [
      engineRuns,
      lighthouseReport,
      networkRun,
      artifacts,
    ] = await Promise.all([
      this.repository.findEngineRuns(scan.id),
      this.repository.findLighthouseReport(scan.id),
      isPro
        ? this.repository.findNetworkRun(scan.id)
        : Promise.resolve(null),
      this.repository.findArtifacts(scan.id),
    ]);

    if (
      scan.status === 'completed' &&
      !lighthouseReport
    ) {
      throw new InternalServerErrorException(
        'Lighthouse report data is missing.',
      );
    }

    const allowedEngines = isPro
      ? engineRuns
      : engineRuns.filter(
          (run) => run.engineType === 'lighthouse',
        );

    const allowedArtifacts = isPro
      ? artifacts
      : artifacts.filter(
          (artifact) =>
            artifact.artifactType === 'lighthouse_json',
        );

    return {
      scan: {
        id: scan.id,
        targetUrl: this.sanitizeUrl(scan.targetUrl),
        status: scan.status,
        planLevel: scan.planLevelAtRequest,
        createdAt: scan.createdAt,
        startedAt: scan.startedAt,
        completedAt: scan.completedAt,
        failureCode: scan.failureCode,
      },

      engines: allowedEngines.map((run) => ({
        engineType: run.engineType,
        status: run.status,
        attempts: run.attempts,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        errorCode: run.errorCode,
      })),

      lighthouse: lighthouseReport
        ? this.sanitizeData(lighthouseReport)
        : null,

      network: isPro && networkRun
        ? this.sanitizeData(networkRun)
        : null,

      artifacts: allowedArtifacts,
    };
  }

  private sanitizeUrl(value: string): string | null {
    try {
      const url = new URL(value);

      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';

      return url.toString();
    } catch {
      return null;
    }
  }

  private sanitizeData(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) =>
        this.sanitizeData(item),
      );
    }

    if (
      value === null ||
      typeof value !== 'object'
    ) {
      return value;
    }

    const result: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();

      if (
        /authorization|cookie|password|secret|token|storagekey|rawnetlogpath|checksum|requestheaders|responseheaders/.test(
          normalizedKey,
        )
      ) {
        continue;
      }

      if (
        typeof child === 'string' &&
        /url|uri/.test(normalizedKey)
      ) {
        result[key] = this.sanitizeUrl(child);
        continue;
      }

      result[key] = this.sanitizeData(child);
    }

    return result;
  }
}