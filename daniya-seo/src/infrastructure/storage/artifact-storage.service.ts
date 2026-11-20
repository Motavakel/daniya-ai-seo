import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

export type ArtifactType =
  | 'lighthouse_json'
  | 'network_netlog'
  | 'network_report'
  | 'console_report'
  | 'performance_trace';

export interface StoredArtifact {
  artifactType: ArtifactType;
  storageProvider: 'local';
  storageKey: string;
  mimeType: string;
  compression: 'gzip';
  sizeBytes: number;
  checksumSha256: string;
  expiresAt: Date;
}

@Injectable()
export class ArtifactStorageService {
  private readonly rootDirectory: string;

  constructor(config: ConfigService) {
    this.rootDirectory = resolve(
      config.getOrThrow<string>('ARTIFACT_STORAGE_DIR'),
    );
  }

  async storeJson(input: {
    scanId: string;
    engineRunId: string;
    artifactType: ArtifactType;
    data: unknown;
    ttlDays: number;
  }): Promise<StoredArtifact> {
    const content = Buffer.from(JSON.stringify(input.data));

    return this.storeBuffer({
      ...input,
      content,
      mimeType: 'application/json',
    });
  }

  async storeBuffer(input: {
    scanId: string;
    engineRunId: string;
    artifactType: ArtifactType;
    content: Buffer;
    mimeType: string;
    ttlDays: number;
  }): Promise<StoredArtifact> {
    if (!Number.isInteger(input.ttlDays) || input.ttlDays < 1) {
      throw new Error('Invalid artifact retention period.');
    }

    const compressed = await gzipAsync(input.content);

    const storageKey = [
      'scans',
      input.scanId,
      input.engineRunId,
      `${input.artifactType}-${randomUUID()}.json.gz`,
    ].join('/');

    const destination = this.resolveStorageKey(storageKey);
    const temporaryPath = `${destination}.tmp`;

    await mkdir(dirname(destination), {
      recursive: true,
      mode: 0o700,
    });

    try {
      await writeFile(temporaryPath, compressed, {
        flag: 'wx',
        mode: 0o600,
      });

      await rename(temporaryPath, destination);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      artifactType: input.artifactType,
      storageProvider: 'local',
      storageKey,
      mimeType: input.mimeType,
      compression: 'gzip',
      sizeBytes: compressed.byteLength,
      checksumSha256: createHash('sha256')
        .update(compressed)
        .digest('hex'),
      expiresAt: new Date(
        Date.now() + input.ttlDays * 24 * 60 * 60 * 1000,
      ),
    };
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.resolveStorageKey(storageKey), {
      force: true,
    });
  }

  private resolveStorageKey(storageKey: string): string {
    if (
      !storageKey ||
      isAbsolute(storageKey) ||
      storageKey.includes('\\') ||
      storageKey.split('/').some((part) => part === '..' || part === '.')
    ) {
      throw new Error('Invalid artifact storage key.');
    }

    const absolutePath = resolve(this.rootDirectory, storageKey);

    if (!absolutePath.startsWith(`${this.rootDirectory}${sep}`)) {
      throw new Error('Artifact path is outside storage directory.');
    }

    return absolutePath;
  }
}