import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { LighthouseExecutionError } from '../domain/lighthouse-execution.error';

export interface LighthouseProcessResult {
  lhr: Record<string, unknown>;
  json: Buffer;
  html: Buffer;
  durationMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class LighthouseProcessRunner {
  constructor(private readonly config: ConfigService) {}

  async run(targetUrl: string): Promise<LighthouseProcessResult> {
    this.assertTargetUrl(targetUrl);

    const startedAt = performance.now();
    const cliPath = resolve(
      process.cwd(),
      'node_modules',
      'lighthouse',
      'cli',
      'index.js',
    );
    const chromePath = this.config.get<string>('CHROME_PATH');
    if (!existsSync(cliPath)) {
      throw new LighthouseExecutionError(
        'LIGHTHOUSE_CLI_NOT_FOUND',
        'Lighthouse is not installed in the worker runtime. Run npm install after updating package.json.',
      );
    }
    if (chromePath && !existsSync(chromePath)) {
      throw new LighthouseExecutionError(
        'LIGHTHOUSE_CHROME_NOT_FOUND',
        'The configured Chrome executable was not found. Check CHROME_PATH.',
      );
    }
    const timeoutMs = this.getBoundedInteger(
      'LIGHTHOUSE_TIMEOUT_MS',
      180_000,
      30_000,
      600_000,
    );
    const maxReportBytes = this.getBoundedInteger(
      'LIGHTHOUSE_MAX_REPORT_BYTES',
      50 * 1024 * 1024,
      1 * 1024 * 1024,
      200 * 1024 * 1024,
    );

    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'daniya-lh-'));
    const outputBase = join(temporaryDirectory, 'lighthouse-report');
    const targetUrlFile = join(temporaryDirectory, 'target-url.txt');
    const jsonPath = `${outputBase}.report.json`;
    const htmlPath = `${outputBase}.report.html`;

    try {
      const chromeFlags = [
        '--headless',
        '--disable-dev-shm-usage',
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ];

      const proxyUrl = this.config.get<string>('BROWSER_PROXY_URL');
      if (proxyUrl) {
        chromeFlags.push(
          `--proxy-server=${proxyUrl}`,
          // Remove Chrome's implicit localhost/loopback proxy bypass.
          '--proxy-bypass-list=<-loopback>',
        );
      }

      if (this.config.get<boolean>('CHROME_NO_SANDBOX', false) === true) {
        chromeFlags.push('--no-sandbox');
      }

      await writeFile(targetUrlFile, `${new URL(targetUrl).toString()}\n`, {
        mode: 0o600,
        flag: 'wx',
      });

      const args = [
        cliPath,
        `--url-file=${targetUrlFile}`,
        '--output=json',
        '--output=html',
        `--output-path=${outputBase}`,
        '--quiet',
        '--only-categories=performance,accessibility,best-practices,seo',
        '--form-factor=mobile',
        '--throttling-method=simulate',
        `--chrome-flags=${chromeFlags.join(' ')}`,
      ];

      await this.runChildProcess({
        args,
        timeoutMs,
        environment: this.safeChildEnvironment(chromePath),
      });

      const [jsonStats, htmlStats] = await Promise.all([
        stat(jsonPath),
        stat(htmlPath),
      ]);
      if (jsonStats.size <= 0 || jsonStats.size > maxReportBytes) {
        throw new LighthouseExecutionError(
          'LIGHTHOUSE_REPORT_SIZE_INVALID',
          'The generated Lighthouse JSON report has an invalid size.',
        );
      }
      if (htmlStats.size <= 0 || htmlStats.size > maxReportBytes) {
        throw new LighthouseExecutionError(
          'LIGHTHOUSE_REPORT_SIZE_INVALID',
          'The generated Lighthouse HTML report has an invalid size.',
        );
      }

      const [json, html] = await Promise.all([
        readFile(jsonPath),
        readFile(htmlPath),
      ]);

      let parsed: unknown;
      try {
        parsed = JSON.parse(json.toString('utf8')) as unknown;
      } catch {
        throw new LighthouseExecutionError(
          'LIGHTHOUSE_INVALID_REPORT',
          'Lighthouse produced an unreadable JSON report.',
        );
      }

      if (!isRecord(parsed) || !isRecord(parsed['audits'])) {
        throw new LighthouseExecutionError(
          'LIGHTHOUSE_INVALID_REPORT',
          'Lighthouse report is missing its audits collection.',
        );
      }

      return {
        lhr: parsed,
        json,
        html,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      if (error instanceof LighthouseExecutionError) throw error;
      throw new LighthouseExecutionError(
        'LIGHTHOUSE_EXECUTION_FAILED',
        'Lighthouse could not complete the browser audit. Check the Chrome runtime and worker logs.',
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }


  /** Do not leak DATABASE_URL, Redis credentials or other app secrets to Chrome. */
  private safeChildEnvironment(chromePath?: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    const allowed = process.platform === 'win32'
      ? ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']
      : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR'];

    for (const key of allowed) {
      const value = process.env[key];
      if (value) environment[key] = value;
    }
    if (chromePath) environment['CHROME_PATH'] = chromePath;
    return environment;
  }

  private assertTargetUrl(targetUrl: string): void {
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch {
      throw new LighthouseExecutionError(
        'LIGHTHOUSE_INVALID_TARGET',
        'The scan target URL is invalid.',
      );
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new LighthouseExecutionError(
        'LIGHTHOUSE_INVALID_TARGET',
        'Lighthouse only accepts HTTP and HTTPS targets.',
      );
    }
    if (url.username || url.password) {
      throw new LighthouseExecutionError(
        'LIGHTHOUSE_INVALID_TARGET',
        'URLs containing embedded credentials are not accepted.',
      );
    }
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

  private runChildProcess(input: {
    args: string[];
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
  }): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (!input.args[0]) {
        rejectPromise(new LighthouseExecutionError(
          'LIGHTHOUSE_CLI_NOT_FOUND',
          'Lighthouse CLI path is not configured.',
        ));
        return;
      }

      const child = spawn(process.execPath, input.args, {
        cwd: process.cwd(),
        env: input.environment,
        stdio: 'ignore',
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      let timedOut = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const killProcessTree = (force: boolean): void => {
        if (!child.pid) return;

        if (process.platform === 'win32') {
          const taskkillArgs = ['/PID', String(child.pid), '/T'];
          if (force) taskkillArgs.push('/F');
          const killer = spawn('taskkill', taskkillArgs, {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.on('error', () => child.kill(force ? 'SIGKILL' : 'SIGTERM'));
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
        killProcessTree(false);
        forceKillTimer = setTimeout(() => killProcessTree(true), 5_000);
        forceKillTimer.unref();
      }, input.timeoutMs);
      timeout.unref();

      child.once('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        rejectPromise(new LighthouseExecutionError(
          'LIGHTHOUSE_PROCESS_START_FAILED',
          'Could not start the Lighthouse process. Verify the Node runtime and installed Lighthouse package.',
        ));
      });

      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);

        if (timedOut) {
          rejectPromise(new LighthouseExecutionError(
            'LIGHTHOUSE_TIMEOUT',
            'Lighthouse exceeded the configured execution timeout.',
          ));
          return;
        }

        if (exitCode !== 0) {
          rejectPromise(new LighthouseExecutionError(
            'LIGHTHOUSE_EXECUTION_FAILED',
            'Lighthouse exited unsuccessfully. Check the Chrome runtime and worker logs.',
          ));
          return;
        }

        resolvePromise();
      });
    });
  }
}
