import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReportArtifactsRepository } from '../../../infrastructure/database/repositories/report-artifacts.repository';
import { ScanRetentionRepository } from '../../../infrastructure/database/repositories/scan-retention.repository';
import { LocalArtifactStorageService } from '../../lighthouse/infrastructure/local-artifact-storage.service';

@Injectable()
export class ArtifactRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ArtifactRetentionService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly artifacts: ReportArtifactsRepository,
    private readonly scans: ScanRetentionRepository,
    private readonly storage: LocalArtifactStorageService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.stopping = false;
    void this.runOnce();
    const intervalMs = this.boundedInteger('ARTIFACT_RETENTION_INTERVAL_MS', 3_600_000, 60_000, 86_400_000);
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private async runOnce(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    let deletedArtifacts = 0;
    try {
      const expired = await this.artifacts.listExpired({ limit: 250 });
      for (const artifact of expired) {
        if (this.stopping) break;
        if (artifact.storageProvider !== 'local') {
          this.logger.error(`Artifact ${artifact.id} uses an unsupported storage provider; metadata was retained.`);
          continue;
        }
        try {
          // remove() is idempotent and validates the storage key against the
          // configured root before touching the filesystem.
          await this.storage.remove(artifact.storageKey);
          const removed = await this.artifacts.deleteMetadataAfterStorageRemoval(artifact.id);
          if (removed) deletedArtifacts += 1;
        } catch {
          this.logger.warn(`Expired artifact ${artifact.id} could not be removed; it will be retried.`);
        }
      }

      // Parent scans are deleted only after every artifact row is gone. Their
      // relational children are then removed through database ON DELETE CASCADE.
      const deletedScans = await this.scans.deleteExpiredWithoutArtifacts({ limit: 250 });
      if (deletedArtifacts > 0 || deletedScans.length > 0) {
        this.logger.log(`Retention removed ${deletedArtifacts} artifacts and ${deletedScans.length} expired scans.`);
      }
    } catch {
      this.logger.error('Artifact retention pass failed.');
    } finally {
      this.running = false;
    }
  }

  private boundedInteger(key: string, fallback: number, min: number, max: number): number {
    const raw = this.config.get<string | number>(key, fallback);
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  }
}
