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

const MOBILE_VIEWPORT = {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  isLandscape: false,
};

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

      const chromeVersion = await browser.version();
      const versionMatch = chromeVersion.match(/Chrome\/([\d.]+)/);

      if (!versionMatch) {
        throw new Error('Unable to determine Chrome version.');
      }

      const mobileUserAgent =
        `Mozilla/5.0 (Linux; Android 10; K) ` +
        `AppleWebKit/537.36 (KHTML, like Gecko) ` +
        `Chrome/${versionMatch[1]} Mobile Safari/537.36`;

      await page.emulate({
        userAgent: mobileUserAgent,
        viewport: MOBILE_VIEWPORT,
      });

      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

      return {
        browser,
        page,
        netLogPath,
        tempDir,
      };
    } catch (error: unknown) {
      if (browser?.connected) {
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
    let url: URL;

    try {
      url = new URL(targetUrl);
    } catch {
      throw new Error('Invalid target URL.');
    }

    if (url.protocol !== 'https:') {
      throw new Error('Only HTTPS URLs are supported.');
    }

    if (url.username || url.password) {
      throw new Error(
        'URLs with embedded credentials are not allowed.',
      );
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
    if (session.browser.connected) {
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