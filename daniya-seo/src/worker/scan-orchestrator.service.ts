import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';

import { DrizzleService } from '../infrastructure/database/drizzle.service';
import { WorkflowRepository, ScanEngineType } from '../modules/workflow/workflow.repository';

import { LighthouseEngine } from '../modules/engines/lighthouse/lighthouse.engine';
import { LighthouseParser } from '../modules/engines/lighthouse/lighthouse.parser';

import { BrowserRunnerService } from '../modules/engines/browser/browser-runner.service';
import { NetworkEngine } from '../modules/engines/network/network.engine';
import { ConsoleEngine } from '../modules/engines/console/console.engine';
import { PerformanceEngine } from '../modules/engines/performance/performance.engine';

import {
  ArtifactStorageService,
  ArtifactType,
} from '../infrastructure/storage/artifact-storage.service';

import { ScanResultsRepository } from './scan-results.repository';
import { AccessService } from '../modules/access/services/access.service';

type ScanRecord = NonNullable<
  Awaited<ReturnType<WorkflowRepository['findScanById']>>
>;

type ClaimedEngineRun = NonNullable<
  Awaited<ReturnType<WorkflowRepository['claimScanEngineRun']>>
>;

type EngineClaimResult =
  | { status: 'claimed'; run: ClaimedEngineRun }
  | { status: 'succeeded' }
  | { status: 'exhausted' };

type ConsoleCapture = ReturnType<ConsoleEngine['start']>;
type PerformanceCapture = Awaited<
  ReturnType<PerformanceEngine['start']>
>;

const PRO_ENGINES: ScanEngineType[] = [
  'network',
  'console',
  'chrome_performance',
];

const ENGINE_LEASE_MS = 120_000;
const LEASE_HEARTBEAT_MS = 30_000;

@Injectable()
export class ScanOrchestratorService {
  private readonly logger = new Logger(
    ScanOrchestratorService.name,
  );

  private readonly maxAttempts: number;
  private readonly observationMs: number;

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly config: ConfigService,
    private readonly workflowRepository: WorkflowRepository,
    private readonly accessService: AccessService,

    private readonly lighthouseEngine: LighthouseEngine,
    private readonly lighthouseParser: LighthouseParser,

    private readonly browserRunner: BrowserRunnerService,
    private readonly networkEngine: NetworkEngine,
    private readonly consoleEngine: ConsoleEngine,
    private readonly performanceEngine: PerformanceEngine,

    private readonly artifactStorage: ArtifactStorageService,
    private readonly scanResultsRepository: ScanResultsRepository,
  ) {
    this.maxAttempts = this.config.get<number>(
      'ENGINE_MAX_ATTEMPTS',
      3,
    );

    this.observationMs = this.config.get<number>(
      'NETWORK_OBSERVATION_MS',
      20_000,
    );
  }

  async process(scanId: string): Promise<void> {
    const scan = await this.drizzle.db.transaction(async (tx) => {
      const current =
        await this.workflowRepository.findScanByIdForUpdate(
          scanId,
          tx,
        );

      if (!current) {
        throw new Error(`Scan not found: ${scanId}`);
      }

      if (
        current.status === 'completed' ||
        current.status === 'failed'
      ) {
        return null;
      }

      if (current.status === 'queued') {
        const started =
          await this.workflowRepository.markScanRunning(
            scanId,
            tx,
          );

        if (!started) {
          throw new Error('Unable to start scan.');
        }
      }

      return current;
    });

    if (!scan) {
      return;
    }

    this.logger.log(`Processing scan ${scanId}`);

    const lighthouseSucceeded =
      await this.processLighthouse(scan);

    if (!lighthouseSucceeded) {
      await this.failScan(scan);
      return;
    }

    if (scan.planLevelAtRequest === 'pro') {
      await this.processProEngines(scan);
    }

    await this.completeScan(scan.id);

    this.logger.log(`Scan ${scanId} completed.`);
  }

  // --------------------------------------------------
  // Lighthouse
  // --------------------------------------------------

  private async processLighthouse(
    scan: ScanRecord,
  ): Promise<boolean> {
    while (true) {
      const claim = await this.claimEngineRun(
        scan.id,
        'lighthouse',
      );

      if (claim.status === 'succeeded') {
        return true;
      }

      if (claim.status === 'exhausted') {
        return false;
      }

      const run = claim.run;
      const heartbeat = this.startLeaseHeartbeat(run);

      let artifactKey: string | undefined;

      try {
        const rawResult = await this.lighthouseEngine.run(
          scan.targetUrl,
        );

        const report = this.lighthouseParser.parse(
          rawResult as Parameters<
            LighthouseParser['parse']
          >[0],
        );

        if (heartbeat.hasLost()) {
          throw new Error('ENGINE_LEASE_LOST');
        }

        const artifact = await this.artifactStorage.storeJson({
          scanId: scan.id,
          engineRunId: run.id,
          artifactType: 'lighthouse_json',
          data: rawResult,
          ttlDays: this.config.get<number>(
            'LIGHTHOUSE_REPORT_TTL_DAYS',
            30,
          ),
        });

        artifactKey = artifact.storageKey;

        await this.scanResultsRepository.saveLighthouse({
          scan,
          engineRunId: run.id,
          lockToken: this.requireLockToken(run),
          report,
          artifact,
        });

        await heartbeat.stop();

        return true;
      } catch (error: unknown) {
        await heartbeat.stop();

        if (artifactKey) {
          await this.artifactStorage
            .remove(artifactKey)
            .catch(() => undefined);
        }

        await this.markEngineFailed(run);

        this.logger.warn(
          `Lighthouse attempt ${run.attempts} failed for scan ${scan.id}.`,
        );

        if (run.attempts >= this.maxAttempts) {
          return false;
        }

        await this.waitBeforeRetry(run.attempts);
      }
    }
  }

  // --------------------------------------------------
  // Pro engines
  // --------------------------------------------------

  private async processProEngines(
    scan: ScanRecord,
  ): Promise<void> {
    while (true) {
      const claims = await this.claimEngineRuns(
        scan.id,
        PRO_ENGINES,
      );

      if (claims.length === 0) {
        return;
      }

      await this.processProBatch(scan, claims);
    }
  }

  private async processProBatch(
    scan: ScanRecord,
    runs: ClaimedEngineRun[],
  ): Promise<void> {
    const heartbeats = new Map<
      ScanEngineType,
      ReturnType<typeof this.startLeaseHeartbeat>
    >();

    const completed = new Set<ScanEngineType>();

    const failures = new Map<ScanEngineType, Error>();

    for (const run of runs) {
      heartbeats.set(
        run.engineType,
        this.startLeaseHeartbeat(run),
      );
    }

    let session:
      | Awaited<ReturnType<BrowserRunnerService['launch']>>
      | undefined;

    let browserClosed = false;

    let consoleCapture: ConsoleCapture | undefined;
    let performanceCapture: PerformanceCapture | undefined;

    let navigationWarning: string | null = null;

    const startedAt = new Date();

    try {
      session = await this.browserRunner.launch();

      const hasConsole = runs.some(
        (run) => run.engineType === 'console',
      );

      const hasPerformance = runs.some(
        (run) => run.engineType === 'chrome_performance',
      );

      // Start captures before navigation.
      if (hasConsole) {
        try {
          consoleCapture = this.consoleEngine.start(
            session.page,
          );
        } catch (error: unknown) {
          failures.set('console', this.toError(error));
        }
      }

      if (hasPerformance) {
        try {
          performanceCapture =
            await this.performanceEngine.start(
              session.page,
            );
        } catch (error: unknown) {
          failures.set(
            'chrome_performance',
            this.toError(error),
          );
        }
      }

      navigationWarning =
        await this.browserRunner.navigate(
          session,
          scan.targetUrl,
        );

      await this.delay(this.observationMs);

      // Stop Console independently.
      if (consoleCapture) {
        try {
          const report = this.consoleEngine.stop(
            consoleCapture,
          );

          await this.saveJsonEngineResult({
            scan,
            engineRunId: this.getRun(runs, 'console').id,
            lockToken: this.requireLockToken(
              this.getRun(runs, 'console'),
            ),
            artifactType: 'console_report',
            report,
            ttlDays: this.config.get<number>(
              'SCAN_RETENTION_DAYS',
              30,
            ),
            heartbeat: heartbeats.get('console'),
          });

          completed.add('console');
        } catch (error: unknown) {
          failures.set('console', this.toError(error));
        }
      }

      // Stop Performance independently.
      if (performanceCapture) {
        try {
          const report = await this.performanceEngine.stop(
            performanceCapture,
          );

          await this.saveJsonEngineResult({
            scan,
            engineRunId: this.getRun(
              runs,
              'chrome_performance',
            ).id,
            lockToken: this.requireLockToken(
              this.getRun(runs, 'chrome_performance'),
            ),
            artifactType: 'performance_trace',
            report,
            ttlDays: this.config.get<number>(
              'SCAN_RETENTION_DAYS',
              30,
            ),
            heartbeat: heartbeats.get(
              'chrome_performance',
            ),
          });

          completed.add('chrome_performance');
        } catch (error: unknown) {
          failures.set(
            'chrome_performance',
            this.toError(error),
          );
        }
      }

      // Close Chrome before reading NetLog.
      await this.browserRunner.close(session);
      browserClosed = true;

      // Network parser works on the finalized NetLog file.
      if (runs.some((run) => run.engineType === 'network')) {
        try {
          const finishedAt = new Date();

          const rawNetLog = await readFile(
            session.netLogPath,
          );

          const options = {
            targetUrl: scan.targetUrl,
            observationSeconds: Math.ceil(
              this.observationMs / 1000,
            ),
            navigationWarning,
            maxDiagnosticRequests: this.config.get<number>(
              'NETWORK_DIAGNOSTIC_MAX_REQUESTS',
              100,
            ),
          } as Parameters<NetworkEngine['run']>[1];

          const report = await this.networkEngine.run(
            session.netLogPath,
            options,
          );

          const networkRun = this.getRun(runs, 'network');

          const ttlDays = this.config.get<number>(
            'NETWORK_ARTIFACT_TTL_DAYS',
            7,
          );

          const netLogArtifact =
            await this.artifactStorage.storeBuffer({
              scanId: scan.id,
              engineRunId: networkRun.id,
              artifactType: 'network_netlog',
              content: rawNetLog,
              mimeType: 'application/json',
              ttlDays,
            });

          let reportArtifact:
            | Awaited<
                ReturnType<
                  ArtifactStorageService['storeJson']
                >
              >
            | undefined;

          try {
            reportArtifact =
              await this.artifactStorage.storeJson({
                scanId: scan.id,
                engineRunId: networkRun.id,
                artifactType: 'network_report',
                data: report,
                ttlDays,
              });

            const heartbeat = heartbeats.get('network');

            if (heartbeat?.hasLost()) {
              throw new Error('ENGINE_LEASE_LOST');
            }

            const chromeVersion =
              await session.browser.version();

            await this.scanResultsRepository.saveNetwork({
              scanId: scan.id,
              engineRunId: networkRun.id,
              lockToken: this.requireLockToken(networkRun),
              chromeVersion,
              targetUrl: scan.targetUrl,
              finalUrl: session.page.url(),
              startedAt,
              finishedAt,
              observationDurationMs: this.observationMs,
              report: report as unknown as Record<
                string,
                unknown
              >,
              artifacts: [
                netLogArtifact,
                reportArtifact,
              ],
            });

            completed.add('network');
          } catch (error: unknown) {
            await Promise.all([
              this.artifactStorage.remove(
                netLogArtifact.storageKey,
              ),
              reportArtifact
                ? this.artifactStorage.remove(
                    reportArtifact.storageKey,
                  )
                : Promise.resolve(),
            ]);

            throw error;
          }
        } catch (error: unknown) {
          failures.set('network', this.toError(error));
        }
      }
    } catch (error: unknown) {
      for (const run of runs) {
        if (!completed.has(run.engineType)) {
          failures.set(
            run.engineType,
            this.toError(error),
          );
        }
      }
    } finally {
      if (session) {
        if (!browserClosed) {
          await this.browserRunner
            .close(session)
            .catch(() => undefined);
        }

        await this.browserRunner
          .cleanup(session)
          .catch(() => undefined);
      }

      for (const heartbeat of heartbeats.values()) {
        await heartbeat.stop();
      }
    }

    // Persist failures independently.
    for (const run of runs) {
      if (completed.has(run.engineType)) {
        continue;
      }

      const error = failures.get(run.engineType);

      if (!error) {
        failures.set(
          run.engineType,
          new Error('Engine did not produce a result.'),
        );
      }

      await this.markEngineFailed(run);
    }

    for (const [engineType, error] of failures) {
      this.logger.warn(
        `${engineType} attempt failed for scan ${scan.id}: ${error.message}`,
      );
    }
  }

  // --------------------------------------------------
  // Engine claiming and leases
  // --------------------------------------------------

  private async claimEngineRun(
    scanId: string,
    engineType: ScanEngineType,
  ): Promise<EngineClaimResult> {
    return this.drizzle.db.transaction(async (tx) => {
      const current =
        await this.workflowRepository.findScanEngineRun(
          scanId,
          engineType,
          tx,
        );

      if (!current) {
        throw new Error(
          `Missing engine run: ${engineType}`,
        );
      }

      if (current.status === 'succeeded') {
        return { status: 'succeeded' };
      }

      if (
        current.status === 'running' &&
        current.leaseExpiresAt &&
        current.leaseExpiresAt > new Date()
      ) {
        throw new Error('ENGINE_LEASE_BUSY');
      }

      if (current.attempts >= this.maxAttempts) {
        if (
          current.status === 'running' &&
          current.leaseExpiresAt &&
          current.leaseExpiresAt <= new Date()
        ) {
          await this.workflowRepository.failExpiredEngineRun(
            current.id,
            this.maxAttempts,
            tx,
          );
        }

        return { status: 'exhausted' };
      }

      const run =
        await this.workflowRepository.claimScanEngineRun(
          {
            scanId,
            engineType,
            maxAttempts: this.maxAttempts,
            leaseDurationMs: ENGINE_LEASE_MS,
          },
          tx,
        );

      if (!run) {
        throw new Error('ENGINE_LEASE_BUSY');
      }

      if (!run.lockToken) {
        throw new Error('ENGINE_LOCK_TOKEN_MISSING');
      }

      return {
        status: 'claimed',
        run,
      };
    });
  }

  private async claimEngineRuns(
    scanId: string,
    engineTypes: ScanEngineType[],
  ): Promise<ClaimedEngineRun[]> {
    return this.drizzle.db.transaction(async (tx) => {
      const claimedRuns: ClaimedEngineRun[] = [];

      for (const engineType of engineTypes) {
        const current =
          await this.workflowRepository.findScanEngineRun(
            scanId,
            engineType,
            tx,
          );

        if (!current) {
          throw new Error(
            `Missing engine run: ${engineType}`,
          );
        }

        if (current.status === 'succeeded') {
          continue;
        }

        if (
          current.status === 'running' &&
          current.leaseExpiresAt &&
          current.leaseExpiresAt > new Date()
        ) {
          throw new Error('ENGINE_LEASE_BUSY');
        }

        if (current.attempts >= this.maxAttempts) {
          if (
            current.status === 'running' &&
            current.leaseExpiresAt &&
            current.leaseExpiresAt <= new Date()
          ) {
            await this.workflowRepository.failExpiredEngineRun(
              current.id,
              this.maxAttempts,
              tx,
            );
          }

          continue;
        }

        const run =
          await this.workflowRepository.claimScanEngineRun(
            {
              scanId,
              engineType,
              maxAttempts: this.maxAttempts,
              leaseDurationMs: ENGINE_LEASE_MS,
            },
            tx,
          );

        if (!run || !run.lockToken) {
          throw new Error('ENGINE_LEASE_BUSY');
        }

        claimedRuns.push(run);
      }

      return claimedRuns;
    });
  }

  private startLeaseHeartbeat(run: ClaimedEngineRun) {
    const lockToken = this.requireLockToken(run);

    let lost = false;
    let stopped = false;
    let heartbeatPromise = Promise.resolve();

    const timer = setInterval(() => {
      if (stopped || lost) {
        return;
      }

      heartbeatPromise = heartbeatPromise
        .then(async () => {
          if (stopped || lost) {
            return;
          }

          const renewed = await this.drizzle.db.transaction(
            (tx) =>
              this.workflowRepository.renewScanEngineRunLease(
                run.id,
                lockToken,
                ENGINE_LEASE_MS,
                tx,
              ),
          );

          if (!renewed) {
            lost = true;
            clearInterval(timer);
          }
        })
        .catch(() => {
          lost = true;
          clearInterval(timer);
        });
    }, LEASE_HEARTBEAT_MS);

    timer.unref();

    return {
      hasLost: () => lost,

      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await heartbeatPromise;
      },
    };
  }

  private async markEngineFailed(
    run: ClaimedEngineRun,
  ): Promise<void> {
    const marked = await this.drizzle.db.transaction((tx) =>
      this.workflowRepository.markScanEngineRunFailed(
        run.id,
        this.requireLockToken(run),
        'ENGINE_EXECUTION_FAILED',
        'Engine execution failed.',
        tx,
      ),
    );

    if (!marked) {
      this.logger.warn(
        `Could not mark engine ${run.engineType} as failed. Its lease may have been lost.`,
      );
    }
  }

  // --------------------------------------------------
  // Persistence helpers
  // --------------------------------------------------

  private async saveJsonEngineResult(input: {
    scan: ScanRecord;
    engineRunId: string;
    lockToken: string;
    artifactType: ArtifactType;
    report: unknown;
    ttlDays: number;
    heartbeat:
      | ReturnType<typeof this.startLeaseHeartbeat>
      | undefined;
  }): Promise<void> {
    if (input.heartbeat?.hasLost()) {
      throw new Error('ENGINE_LEASE_LOST');
    }

    const artifact = await this.artifactStorage.storeJson({
      scanId: input.scan.id,
      engineRunId: input.engineRunId,
      artifactType: input.artifactType,
      data: input.report,
      ttlDays: input.ttlDays,
    });

    try {
      await this.scanResultsRepository.saveEngineArtifact({
        scanId: input.scan.id,
        engineRunId: input.engineRunId,
        lockToken: input.lockToken,
        artifact,
      });
    } catch (error: unknown) {
      await this.artifactStorage
        .remove(artifact.storageKey)
        .catch(() => undefined);

      throw error;
    }
  }

  // --------------------------------------------------
  // Scan finalization
  // --------------------------------------------------

  private async failScan(scan: ScanRecord): Promise<void> {
    await this.drizzle.db.transaction(async (tx) => {
      const released =
        await this.workflowRepository.releasePageCycleSlot(
          scan.slotId,
          tx,
        );

      if (released) {
        await this.accessService.releasePageQuota(
          scan.cycleId,
          tx,
        );
      }

      await this.workflowRepository.markScanFailed(
        scan.id,
        'LIGHTHOUSE_FAILED',
        'Lighthouse execution failed after maximum attempts.',
        tx,
      );
    });

    this.logger.error(`Scan ${scan.id} failed.`);
  }

  private async completeScan(scanId: string): Promise<void> {
    await this.drizzle.db.transaction(async (tx) => {
      const completed =
        await this.workflowRepository.markScanCompleted(
          scanId,
          tx,
        );

      if (!completed) {
        const scan =
          await this.workflowRepository.findScanById(
            scanId,
            tx,
          );

        if (scan?.status !== 'completed') {
          throw new Error('Unable to complete scan.');
        }
      }
    });
  }

  // --------------------------------------------------
  // Utilities
  // --------------------------------------------------

  private getRun(
    runs: ClaimedEngineRun[],
    engineType: ScanEngineType,
  ): ClaimedEngineRun {
    const run = runs.find(
      (item) => item.engineType === engineType,
    );

    if (!run) {
      throw new Error(`Engine run not claimed: ${engineType}`);
    }

    return run;
  }

  private requireLockToken(
    run: ClaimedEngineRun,
  ): string {
    if (!run.lockToken) {
      throw new Error('Engine lock token is missing.');
    }

    return run.lockToken;
  }

  private toError(error: unknown): Error {
    return error instanceof Error
      ? error
      : new Error(String(error));
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const delayMs = Math.min(
      10_000,
      500 * 2 ** Math.max(0, attempt - 1),
    );

    await this.delay(delayMs);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}