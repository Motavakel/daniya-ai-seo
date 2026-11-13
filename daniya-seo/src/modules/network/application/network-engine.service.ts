import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NetworkCapturesRepository } from '../../../infrastructure/database/repositories/network-captures.repository';
import { ScanEngineRunsRepository } from '../../../infrastructure/database/repositories/scan-engine-runs.repository';
import { ScansRepository } from '../../../infrastructure/database/repositories/scans.repository';
import { NetworkEngineError } from '../domain/network-engine.error';
import { NetLogParser } from '../domain/netlog-parser';
import { ChromeNetLogRunner } from '../infrastructure/chrome-netlog.runner';
import { NetworkArtifactStorageService } from '../infrastructure/network-artifact-storage.service';

export interface ExecuteNetworkEngineInput {
  scanId: string;
  engineRunId: string;
}

export interface ExecuteNetworkEngineResult {
  scanId: string;
  engineRunId: string;
  networkRunId: string;
  requestCount: number;
  failedRequestCount: number;
  artifactCount: number;
  durationMs: number;
  reusedExistingResult: boolean;
}

@Injectable()
export class NetworkEngineService {
  private readonly logger = new Logger(NetworkEngineService.name);

  constructor(
    private readonly scans: ScansRepository,
    private readonly engineRuns: ScanEngineRunsRepository,
    private readonly captures: NetworkCapturesRepository,
    private readonly runner: ChromeNetLogRunner,
    private readonly parser: NetLogParser,
    private readonly storage: NetworkArtifactStorageService,
    private readonly config: ConfigService,
  ) {}

  async execute(input: ExecuteNetworkEngineInput): Promise<ExecuteNetworkEngineResult> {
    const scan = await this.scans.findById(input.scanId);
    if (!scan) throw new NotFoundException('Scan not found.');
    if (scan.profile !== 'detailed') {
      throw new ConflictException('Network capture is not enabled for this scan profile.');
    }

    const engineRun = await this.engineRuns.findById(input.engineRunId);
    if (!engineRun || engineRun.scanId !== scan.id || engineRun.engine !== 'network') {
      throw new NotFoundException('Network engine run not found.');
    }

    const existingRun = await this.captures.findRunByEngineRunId(engineRun.id);
    if (existingRun) {
      if (engineRun.status === 'queued') {
        const running = await this.engineRuns.markRunning({
          engineRunId: engineRun.id,
          workerId: this.workerId(),
        });
        if (running) await this.engineRuns.markSucceeded({ engineRunId: engineRun.id });
      } else if (engineRun.status === 'running') {
        await this.engineRuns.markSucceeded({ engineRunId: engineRun.id });
      }
      return {
        scanId: scan.id,
        engineRunId: engineRun.id,
        networkRunId: existingRun.id,
        requestCount: existingRun.totalRequests,
        failedRequestCount: existingRun.failedRequests,
        artifactCount: 0,
        durationMs: Number(engineRun.durationMs ?? 0),
        reusedExistingResult: true,
      };
    }

    const running = await this.engineRuns.markRunning({
      engineRunId: engineRun.id,
      workerId: this.workerId(),
    });
    if (!running) {
      throw new ConflictException('Network engine run is not in a queued state.');
    }

    const startedAt = performance.now();
    const storedKeys: string[] = [];
    let capturePersisted = false;

    try {
      const capture = await this.runner.run(scan.targetUrl);
      const parsed = this.parser.parse(capture.netlog, {
        captureStartedAt: capture.captureStartedAt,
        captureFinishedAt: capture.captureFinishedAt,
        chromeVersion: capture.chromeVersion,
        targetHostname: scan.hostname,
      });

      const rawArtifact = await this.storage.store({
        scanId: scan.id,
        kind: 'chrome-netlog',
        content: capture.netlog,
      });
      storedKeys.push(rawArtifact.storageKey);

      const normalizedArtifact = await this.storage.store({
        scanId: scan.id,
        kind: 'network-normalized',
        content: Buffer.from(JSON.stringify(parsed.requests), 'utf8'),
      });
      storedKeys.push(normalizedArtifact.storageKey);

      const retentionDays = this.boundedInteger('NETWORK_ARTIFACT_TTL_DAYS', 1, 1, 30);
      const expiresAt = new Date(Date.now() + retentionDays * 86_400_000);
      const failedRequestCount = parsed.requests.filter(
        (request) => Boolean(request.failureCode) || (request.statusCode != null && request.statusCode >= 400),
      ).length;
      const totalTransferredBytes = this.sumKnownBytes(parsed.requests, 'transferredBytes');
      const totalEncodedBodyBytes = this.sumKnownBytes(parsed.requests, 'encodedBodyBytes');
      const totalDecodedBodyBytes = this.sumKnownBytes(parsed.requests, 'decodedBodyBytes');

      const saved = await this.captures.persistCapture({
        run: {
          scanId: scan.id,
          engineRunId: engineRun.id,
          chromeVersion: capture.chromeVersion,
          netlogVersion: parsed.netlogVersion,
          parserVersion: '1.0.0',
          captureStartedAt: capture.captureStartedAt,
          captureFinishedAt: capture.captureFinishedAt,
          observationDurationMs: String(capture.observationDurationMs),
          totalRequests: parsed.requests.length,
          failedRequests: failedRequestCount,
          totalTransferredBytes,
          totalEncodedBodyBytes,
          totalDecodedBodyBytes,
          captureContext: {
            ...parsed.captureContext,
            observationDurationMs: capture.observationDurationMs,
            observationWindowMs: this.boundedInteger('NETWORK_OBSERVATION_MS', 20_000, 5_000, 90_000),
            egressRegion: this.config.get<string>('BROWSER_EGRESS_REGION') ?? null,
          },
        },
        requests: parsed.requests,
        artifacts: [
          {
            scanId: scan.id,
            engineRunId: engineRun.id,
            reportId: null,
            kind: 'chrome_netlog',
            storageProvider: rawArtifact.storageProvider,
            storageKey: rawArtifact.storageKey,
            fileName: rawArtifact.fileName,
            contentType: rawArtifact.contentType,
            sizeBytes: rawArtifact.sizeBytes,
            checksumSha256: rawArtifact.checksumSha256,
            isSensitive: true,
            expiresAt,
          },
          {
            scanId: scan.id,
            engineRunId: engineRun.id,
            reportId: null,
            kind: 'network_normalized_json',
            storageProvider: normalizedArtifact.storageProvider,
            storageKey: normalizedArtifact.storageKey,
            fileName: normalizedArtifact.fileName,
            contentType: normalizedArtifact.contentType,
            sizeBytes: normalizedArtifact.sizeBytes,
            checksumSha256: normalizedArtifact.checksumSha256,
            isSensitive: true,
            expiresAt,
          },
        ],
      });
      capturePersisted = true;

      if (saved.reusedExisting) {
        // Another execution persisted this engine run first. Remove this
        // attempt's duplicate local files; its committed artifact rows remain.
        await Promise.all(storedKeys.map((key) => this.storage.remove(key).catch(() => undefined)));
        storedKeys.length = 0;
      }

      const durationMs = Math.max(
        capture.observationDurationMs,
        Math.round(performance.now() - startedAt),
      );
      await this.engineRuns.markSucceeded({
        engineRunId: engineRun.id,
        durationMs: String(durationMs),
      });

      return {
        scanId: scan.id,
        engineRunId: engineRun.id,
        networkRunId: saved.run.id,
        requestCount: saved.persistedRequestCount,
        failedRequestCount,
        artifactCount: saved.artifactCount,
        durationMs,
        reusedExistingResult: saved.reusedExisting,
      };
    } catch (error) {
      if (!capturePersisted) {
        await Promise.all(
          storedKeys.map((key) => this.storage.remove(key).catch(() => undefined)),
        );
        const failure = this.safeFailure(error);
        await this.engineRuns.markFailed({
          engineRunId: engineRun.id,
          errorCode: failure.code,
          errorMessage: failure.message,
          durationMs: String(Math.round(performance.now() - startedAt)),
        });
      }

      this.logger.error(`Network Engine failed for run ${engineRun.id}: ${this.safeFailure(error).code}`);
      if (error instanceof NetworkEngineError) throw error;
      throw new NetworkEngineError(
        this.safeFailure(error).code,
        'Network capture or persistence failed.',
      );
    }
  }

  private sumKnownBytes(
    requests: ReadonlyArray<{
      transferredBytes?: number | null;
      encodedBodyBytes?: number | null;
      decodedBodyBytes?: number | null;
    }>,
    key: 'transferredBytes' | 'encodedBodyBytes' | 'decodedBodyBytes',
  ): number | null {
    const values = requests
      .map((request) => request[key])
      .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
    if (values.length === 0) return null;
    const total = values.reduce((sum, value) => sum + value, 0);
    return Number.isSafeInteger(total) ? total : null;
  }

  private safeFailure(error: unknown): { code: string; message: string } {
    if (error instanceof NetworkEngineError) {
      return { code: error.code.slice(0, 64), message: error.message.slice(0, 2_000) };
    }
    const raw = error instanceof Error ? error.message : '';
    const allowed = new Set([
      'CHROME_EXECUTABLE_NOT_FOUND',
      'CHROME_SANDBOX_DISABLED_IN_PRODUCTION',
      'NETLOG_FILE_SIZE_INVALID',
      'NETLOG_INVALID_JSON',
      'NETLOG_UNSUPPORTED_FORMAT',
      'CHROME_PROCESS_START_FAILED',
      'CHROME_CAPTURE_TIMEOUT',
      'CHROME_CAPTURE_FAILED',
      'BROWSER_PROXY_URL_REQUIRED',
    ]);
    return {
      code: allowed.has(raw) ? raw.replace(/[^A-Z0-9_]/g, '_').slice(0, 64) : 'NETWORK_ENGINE_FAILED',
      message: 'Network capture or persistence failed.',
    };
  }

  private workerId(): string {
    return (this.config.get<string>('WORKER_ID') ?? `${process.env['HOSTNAME'] ?? 'worker'}-${process.pid}`).slice(0, 128);
  }

  private boundedInteger(key: string, fallback: number, min: number, max: number): number {
    const raw = this.config.get<string | number>(key, fallback);
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  }
}
