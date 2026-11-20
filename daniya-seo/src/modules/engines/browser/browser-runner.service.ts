import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BrowserSession {
  browser: Browser;
  page: Page;
  netLogPath: string;
  tempDir: string;
}

const NAVIGATION_TIMEOUT_MS = 90_000;
const BYTES_PER_MB = 1024 * 1024;

@Injectable()
export class BrowserRunnerService {
  constructor(private readonly config: ConfigService) {}

  async launch(): Promise<BrowserSession> {
    const tempDir = await mkdtemp(join(tmpdir(), 'daniya-seo-'));
    const netLogPath = join(tempDir, 'chrome-netlog.json');

    let browser: Browser | undefined;

    try {
      const observationMs = this.config.get<number>(
        'NETWORK_OBSERVATION_MS',
        20_000,
      );

      const maxNetLogBytes = this.config.get<number>(
        'NETWORK_NETLOG_MAX_BYTES',
        100 * BYTES_PER_MB,
      );

      if (
        !Number.isInteger(observationMs) ||
        observationMs < 5_000 ||
        !Number.isInteger(maxNetLogBytes) ||
        maxNetLogBytes < BYTES_PER_MB
      ) {
        throw new Error('Invalid NetLog configuration.');
      }

      const maxSizeMb = Math.floor(
        maxNetLogBytes / BYTES_PER_MB,
      );

      const netLogDurationSeconds =
        Math.ceil(
          (NAVIGATION_TIMEOUT_MS + observationMs) / 1000,
        ) + 30;

      const chromePath = this.config.getOrThrow<string>(
        'CHROME_PATH',
      );

      const args = [
        '--no-first-run',
        `--log-net-log=${netLogPath}`,
        '--net-log-capture-mode=Default',
        `--net-log-duration=${netLogDurationSeconds}`,
        `--net-log-max-size-mb=${maxSizeMb}`,
      ];

      if (
        this.config.get<boolean>('CHROME_NO_SANDBOX', false)
      ) {
        args.push('--no-sandbox', '--disable-setuid-sandbox');
      }

      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args,
        timeout: 30_000,
      });

      const pages = await browser.pages();
      const page = pages[0] ?? await browser.newPage();

      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

      await page.setViewport({
        width: 1365,
        height: 900,
      });

      return {
        browser,
        page,
        netLogPath,
        tempDir,
      };
    } catch (error: unknown) {
      if (browser?.isConnected()) {
        await browser.close().catch(() => undefined);
      }

      await rm(tempDir, {
        recursive: true,
        force: true,
      }).catch(() => undefined);

      throw error;
    }
  }

  async navigate(
    session: BrowserSession,
    targetUrl: string,
  ): Promise<string | null> {
    const url = new URL(targetUrl);

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Only HTTP and HTTPS URLs are supported.');
    }

    if (url.username || url.password) {
      throw new Error('URLs with embedded credentials are not allowed.');
    }

    try {
      await session.page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });

      return null;
    } catch (error: unknown) {
      return error instanceof Error
        ? error.message
        : String(error);
    }
  }

  async close(session: BrowserSession): Promise<void> {
    if (session.browser.isConnected()) {
      await session.browser.close();
    }
  }

  async cleanup(session: BrowserSession): Promise<void> {
    await rm(session.tempDir, {
      recursive: true,
      force: true,
    });
  }

  async dispose(session: BrowserSession): Promise<void> {
    try {
      await this.close(session);
    } finally {
      await this.cleanup(session);
    }
  }
}