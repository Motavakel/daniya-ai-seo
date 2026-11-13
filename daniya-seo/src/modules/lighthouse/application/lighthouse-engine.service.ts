import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LighthouseAuditsRepository } from '../../../infrastructure/database/repositories/lighthouse-audits.repository';
import { LighthouseReportsRepository } from '../../../infrastructure/database/repositories/lighthouse-reports.repository';
import { ScanEngineRunsRepository } from '../../../infrastructure/database/repositories/scan-engine-runs.repository';
import { ScansRepository } from '../../../infrastructure/database/repositories/scans.repository';
import { LighthouseReportParser } from '../domain/lighthouse-report.parser';
import { LighthouseProcessRunner } from '../infrastructure/lighthouse-process.runner';
import { LighthouseExecutionError } from '../domain/lighthouse-execution.error';
import { LocalArtifactStorageService } from '../infrastructure/local-artifact-storage.service';

export interface ExecuteLighthouseEngineInput {
  scanId: string;
  engineRunId: string;
}

export interface ExecuteLighthouseEngineResult {
  scanId: string;
  engineRunId: string;
  lighthouseReportId: string;
  auditCount: number;
  artifactCount: number;
  durationMs: number;
  reusedExistingResult: boolean;
}

@Injectable()
export class LighthouseEngineService {
  private readonly logger = new Logger(LighthouseEngineService.name);

  constructor(
    private readonly scans: ScansRepository,
    private readonly engineRuns: ScanEngineRunsRepository,
    private readonly reports: LighthouseReportsRepository,
    private readonly audits: LighthouseAuditsRepository,
    private readonly runner: LighthouseProcessRunner,
    private readonly parser: LighthouseReportParser,
    private readonly storage: LocalArtifactStorageService,
    private readonly config: ConfigService,
  ) {}

  async execute(
    input: ExecuteLighthouseEngineInput,
  ): Promise<ExecuteLighthouseEngineResult> {
    const scan = await this.scans.findById(input.scanId);
    if (!scan) throw new NotFoundException('Scan not found.');

    const engineRun = await this.engineRuns.findById(input.engineRunId);
    if (
      !engineRun ||
      engineRun.scanId !== scan.id ||
      engineRun.engine !== 'lighthouse'
    ) {
      throw new NotFoundException('Lighthouse engine run not found.');
    }

    const existingReport = await this.reports.findByEngineRunId(engineRun.id);
    if (existingReport) {
      if (engineRun.status === 'queued') {
        const started = await this.engineRuns.markRunning({
          engineRunId: engineRun.id,
          workerId: this.getWorkerId(),
        });
        if (started) await this.engineRuns.markSucceeded({ engineRunId: engineRun.id });
      } else if (engineRun.status === 'running') {
        await this.engineRuns.markSucceeded({ engineRunId: engineRun.id });
      }

      const auditRows = await this.audits.listByReportId({
        reportId: existingReport.id,
        limit: 1_000,
      });
      return {
        scanId: scan.id,
        engineRunId: engineRun.id,
        lighthouseReportId: existingReport.id,
        auditCount: auditRows.length,
        artifactCount: 0,
        durationMs: Number(engineRun.durationMs ?? 0),
        reusedExistingResult: true,
      };
    }

    const running = await this.engineRuns.markRunning({
      engineRunId: engineRun.id,
      workerId: this.getWorkerId(),
    });
    if (!running) {
      throw new ConflictException('Lighthouse engine run is not in a queued state.');
    }

    const startedAt = performance.now();
    const storedKeys: string[] = [];
    let snapshotPersisted = false;

    try {
      const output = await this.runner.run(scan.targetUrl);
      const parsed = this.parser.parse(output.lhr);

      const jsonArtifact = await this.storage.store({
        scanId: scan.id,
        extension: 'json',
        content: output.json,
      });
      storedKeys.push(jsonArtifact.storageKey);

      const htmlArtifact = await this.storage.store({
        scanId: scan.id,
        extension: 'html',
        content: output.html,
      });
      storedKeys.push(htmlArtifact.storageKey);

      const reportTtlDays = this.getBoundedInteger(
        'LIGHTHOUSE_REPORT_TTL_DAYS',
        30,
        1,
        365,
      );
      const expiresAt = new Date(Date.now() + reportTtlDays * 86_400_000);
      const durationMs = Math.max(
        output.durationMs,
        Math.round(performance.now() - startedAt),
      );

      const saved = await this.reports.saveSnapshot({
        report: {
          scanId: scan.id,
          engineRunId: engineRun.id,
          ...parsed.report,
        },
        audits: parsed.audits,
        artifacts: [
          {
            scanId: scan.id,
            engineRunId: engineRun.id,
            kind: 'lighthouse_json',
            storageProvider: jsonArtifact.storageProvider,
            storageKey: jsonArtifact.storageKey,
            fileName: jsonArtifact.fileName,
            contentType: jsonArtifact.contentType,
            sizeBytes: jsonArtifact.sizeBytes,
            checksumSha256: jsonArtifact.checksumSha256,
            isSensitive: true,
            expiresAt,
          },
          {
            scanId: scan.id,
            engineRunId: engineRun.id,
            kind: 'lighthouse_html',
            storageProvider: htmlArtifact.storageProvider,
            storageKey: htmlArtifact.storageKey,
            fileName: htmlArtifact.fileName,
            contentType: htmlArtifact.contentType,
            sizeBytes: htmlArtifact.sizeBytes,
            checksumSha256: htmlArtifact.checksumSha256,
            isSensitive: true,
            expiresAt,
          },
        ],
      });
      snapshotPersisted = true;

      const succeeded = await this.engineRuns.markSucceeded({
        engineRunId: engineRun.id,
        durationMs: String(durationMs),
      });

      if (!succeeded) {
        // The persisted result remains authoritative. A retry can safely reuse it.
        this.logger.warn(
          `Lighthouse report persisted but engine-run status transition was not applied for run ${engineRun.id}.`,
        );
      }

      return {
        scanId: scan.id,
        engineRunId: engineRun.id,
        lighthouseReportId: saved.report.id,
        auditCount: saved.auditCount,
        artifactCount: saved.artifactCount,
        durationMs,
        reusedExistingResult: false,
      };
    } catch (error) {
      if (!snapshotPersisted) {
        await Promise.all(
          storedKeys.map((storageKey) =>
            this.storage.remove(storageKey).catch(() => undefined),
          ),
        );

        const failure = this.toSafeFailure(error);
        await this.engineRuns.markFailed({
          engineRunId: engineRun.id,
          errorCode: failure.code,
          errorMessage: failure.message,
          durationMs: String(Math.round(performance.now() - startedAt)),
        });
      }

      if (error instanceof LighthouseExecutionError) throw error;
      this.logger.error(
        `Lighthouse engine failed for engine run ${engineRun.id}.`,
      );
      throw new LighthouseExecutionError(
        'LIGHTHOUSE_ENGINE_FAILED',
        'Lighthouse execution or persistence failed.',
      );
    }
  }

  private getWorkerId(): string {
    return (
      this.config.get<string>('WORKER_ID') ??
      `${process.env['HOSTNAME'] ?? 'worker'}-${process.pid}`
    ).slice(0, 128);
  }

  private getBoundedInteger(
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const raw = this.config.get<string | number>(key, fallback);
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, minimum), maximum);
  }

  private toSafeFailure(error: unknown): { code: string; message: string } {
    if (error instanceof LighthouseExecutionError) {
      return {
        code: error.code,
        message: error.message.slice(0, 2_000),
      };
    }
    return {
      code: 'LIGHTHOUSE_ENGINE_FAILED',
      message: 'Lighthouse execution or persistence failed.',
    };
  }
}
