import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export interface StoreLighthouseArtifactInput {
  scanId: string;
  extension: 'json' | 'html';
  content: Buffer;
}

export interface StoredLighthouseArtifact {
  storageProvider: 'local';
  storageKey: string;
  fileName: string;
  contentType: 'application/json' | 'text/html; charset=utf-8';
  sizeBytes: number;
  checksumSha256: string;
}

@Injectable()
export class LocalArtifactStorageService {
  private readonly rootDirectory: string;

  constructor(config: ConfigService) {
    this.rootDirectory = resolve(
      config.get<string>('ARTIFACT_STORAGE_DIR', './var/artifacts'),
    );
  }

  async store(input: StoreLighthouseArtifactInput): Promise<StoredLighthouseArtifact> {
    const artifactId = randomUUID();
    const storageKey = join('lighthouse', input.scanId, `${artifactId}.${input.extension}`)
      .split(sep)
      .join('/');
    const destination = this.resolveStorageKey(storageKey);
    const temporaryPath = `${destination}.${randomUUID()}.tmp`;

    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, input.content, { mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, destination);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      storageProvider: 'local',
      storageKey,
      fileName: `lighthouse-report.${input.extension}`,
      contentType:
        input.extension === 'json'
          ? 'application/json'
          : 'text/html; charset=utf-8',
      sizeBytes: input.content.byteLength,
      checksumSha256: createHash('sha256').update(input.content).digest('hex'),
    };
  }

  async remove(storageKey: string): Promise<void> {
    const path = this.resolveStorageKey(storageKey);
    await rm(path, { force: true });
  }

  private resolveStorageKey(storageKey: string): string {
    if (
      !storageKey ||
      isAbsolute(storageKey) ||
      storageKey.includes('\\') ||
      storageKey.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      throw new Error('Invalid private artifact storage key.');
    }

    const absolutePath = resolve(this.rootDirectory, storageKey);
    const expectedPrefix = `${this.rootDirectory}${sep}`;
    if (!absolutePath.startsWith(expectedPrefix)) {
      throw new Error('Artifact path escaped the configured storage directory.');
    }
    return absolutePath;
  }
}
