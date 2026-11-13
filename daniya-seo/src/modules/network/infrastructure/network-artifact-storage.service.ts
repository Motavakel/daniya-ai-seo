import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export interface StoredNetworkArtifact {
  storageProvider: 'local';
  storageKey: string;
  fileName: string;
  contentType: 'application/json';
  sizeBytes: number;
  checksumSha256: string;
}

@Injectable()
export class NetworkArtifactStorageService {
  private readonly rootDirectory: string;

  constructor(config: ConfigService) {
    this.rootDirectory = resolve(config.get<string>('ARTIFACT_STORAGE_DIR', './var/artifacts'));
  }

  async store(input: {
    scanId: string;
    kind: 'chrome-netlog' | 'network-normalized';
    content: Buffer;
  }): Promise<StoredNetworkArtifact> {
    const id = randomUUID();
    const storageKey = join('network', input.scanId, `${id}.json`).split(sep).join('/');
    const destination = this.resolveKey(storageKey);
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
      fileName: input.kind === 'chrome-netlog' ? 'chrome-netlog.json' : 'network-normalized.json',
      contentType: 'application/json',
      sizeBytes: input.content.byteLength,
      checksumSha256: createHash('sha256').update(input.content).digest('hex'),
    };
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.resolveKey(storageKey), { force: true });
  }

  private resolveKey(storageKey: string): string {
    if (
      !storageKey ||
      isAbsolute(storageKey) ||
      storageKey.includes('\\') ||
      storageKey.split('/').some((part) => part === '.' || part === '..')
    ) {
      throw new Error('INVALID_PRIVATE_ARTIFACT_KEY');
    }
    const absolute = resolve(this.rootDirectory, storageKey);
    if (!absolute.startsWith(`${this.rootDirectory}${sep}`)) {
      throw new Error('ARTIFACT_PATH_TRAVERSAL');
    }
    return absolute;
  }
}
