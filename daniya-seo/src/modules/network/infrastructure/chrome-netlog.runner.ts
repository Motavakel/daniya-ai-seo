import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TargetUrlValidator } from '../../security/target-url.validator';

export interface ChromeNetLogCapture {
  netlog: Buffer;
  chromeVersion: string | null;
  captureStartedAt: Date;
  captureFinishedAt: Date;
  observationDurationMs: number;
}

@Injectable()
export class ChromeNetLogRunner {
  constructor(
    private readonly config: ConfigService,
    private readonly targetValidator: TargetUrlValidator,
  ) {}

  async run(targetUrl: string): Promise<ChromeNetLogCapture> {
    const validated = await this.targetValidator.validate(targetUrl);
    const chromePath = this.config.get<string>('CHROME_PATH');
    if (!chromePath || !existsSync(chromePath)) {
      throw new Error('CHROME_EXECUTABLE_NOT_FOUND');
    }

    const noSandbox = this.config.get<boolean>('CHROME_NO_SANDBOX', false) === true;
    if (noSandbox && this.config.get<string>('NODE_ENV') === 'production') {
      throw new Error('CHROME_SANDBOX_DISABLED_IN_PRODUCTION');
    }

    const observationMs = this.boundedInteger(
      'NETWORK_OBSERVATION_MS',
      20_000,
      5_000,
      90_000,
    );
    const timeoutMs = observationMs + 60_000;
    const maxNetLogBytes = this.boundedInteger(
      'NETWORK_NETLOG_MAX_BYTES',
      100 * 1024 * 1024,
      1 * 1024 * 1024,
      300 * 1024 * 1024,
    );

    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'daniya-netlog-'));
    const netlogPath = join(temporaryDirectory, 'chrome-netlog.json');
    const userDataDirectory = join(temporaryDirectory, 'chrome-profile');
    const captureStartedAt = new Date();

    try {
      const args = [
        '--headless=new',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--dns-prefetch-disable',
        '--metrics-recording-only',
        '--window-size=1365,768',
        `--user-data-dir=${userDataDirectory}`,
        `--log-net-log=${netlogPath}`,
        '--net-log-capture-mode=Default',
        `--timeout=${observationMs}`,
        '--dump-dom',
      ];

      const proxyUrl = this.config.get<string>('BROWSER_PROXY_URL');
      if (proxyUrl) {
        args.push(`--proxy-server=${proxyUrl}`);
        // Remove Chromium's implicit localhost bypass. The egress proxy must
        // reject all private, loopback, link-local and metadata destinations.
        args.push('--proxy-bypass-list=<-loopback>');
      }
      if (noSandbox) args.push('--no-sandbox');
      args.push(validated.url);

      await this.runProcess(chromePath, args, timeoutMs);

      const fileStats = await stat(netlogPath).catch(() => null);
      if (!fileStats || fileStats.size <= 0 || fileStats.size > maxNetLogBytes) {
        throw new Error('NETLOG_FILE_SIZE_INVALID');
      }

      const netlog = await readFile(netlogPath);
      const captureFinishedAt = new Date();
      const chromeVersion = await this.getChromeVersion(chromePath);

      return {
        netlog,
        chromeVersion,
        captureStartedAt,
        captureFinishedAt,
        observationDurationMs: captureFinishedAt.getTime() - captureStartedAt.getTime(),
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async getChromeVersion(chromePath: string): Promise<string | null> {
    return new Promise((resolvePromise) => {
      const child = spawn(chromePath, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env: this.safeChildEnvironment(),
      });
      let output = '';
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(0, 256);
      });
      child.once('error', () => {
        clearTimeout(timeout);
        resolvePromise(null);
      });
      child.once('close', () => {
        clearTimeout(timeout);
        const version = output.match(/(?:Google Chrome|Chromium)\s+([0-9.]+)/i)?.[1];
        resolvePromise(version ?? null);
      });
    });
  }

  private runProcess(executable: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, args, {
        stdio: 'ignore',
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: this.safeChildEnvironment(),
      });

      let settled = false;
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const killTree = (force: boolean): void => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          const taskkill = spawn(
            'taskkill',
            ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
            { stdio: 'ignore', windowsHide: true },
          );
          taskkill.once('error', () => child.kill(force ? 'SIGKILL' : 'SIGTERM'));
          return;
        }
        try {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          child.kill(force ? 'SIGKILL' : 'SIGTERM');
        }
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        killTree(false);
        forceKillTimer = setTimeout(() => killTree(true), 5_000);
        forceKillTimer.unref();
      }, timeoutMs);
      timeout.unref();

      child.once('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        rejectPromise(new Error('CHROME_PROCESS_START_FAILED'));
      });

      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (timedOut) {
          rejectPromise(new Error('CHROME_CAPTURE_TIMEOUT'));
        } else if (exitCode !== 0) {
          rejectPromise(new Error('CHROME_CAPTURE_FAILED'));
        } else {
          resolvePromise();
        }
      });
    });
  }

  private safeChildEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    const allowed = process.platform === 'win32'
      ? ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']
      : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR'];
    for (const key of allowed) {
      const value = process.env[key];
      if (value) environment[key] = value;
    }
    return environment;
  }

  private boundedInteger(key: string, fallback: number, min: number, max: number): number {
    const raw = this.config.get<string | number>(key, fallback);
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  }
}
