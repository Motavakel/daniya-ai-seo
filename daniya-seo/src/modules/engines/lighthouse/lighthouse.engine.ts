import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LighthouseEngine {
  private readonly logger = new Logger(LighthouseEngine.name);

  constructor(private readonly config: ConfigService) {}

  async run(targetUrl: string) {
    let chrome:
      | {
          port: number;
          kill: () => void;
        }
      | undefined;

    try {
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

      const chromeLauncher = await import('chrome-launcher');
      const lighthouseModule = await import('lighthouse');

      const chromeFlags = ['--headless=new'];

      if (this.config.get<string>('CHROME_NO_SANDBOX') === 'true') {
        chromeFlags.push('--no-sandbox', '--disable-setuid-sandbox');
      }

      const chromePath = this.config.get<string>('CHROME_PATH');

      const launchedChrome = await chromeLauncher.launch({
        ...(chromePath ? { chromePath } : {}),
        chromeFlags,
        handleSIGINT: false,
        logLevel: 'error',
      });

      chrome = launchedChrome;

      const result = await lighthouseModule.default(
        targetUrl,
        {
          port: launchedChrome.port,
          output: 'json',
          logLevel: 'error',
        },
        {
          extends: 'lighthouse:default',
          settings: {
            formFactor: 'mobile',
            screenEmulation: {
              width: 390,
              height: 844,
              deviceScaleFactor: 3,
              mobile: true,
              disabled: false,
            },
          },
        },
      );

      if (!result) {
        throw new Error('Lighthouse did not return a report.');
      }

      return result.lhr;
    } catch (error: unknown) {
      const cause =
        error instanceof Error ? error : new Error(String(error));

      this.logger.error(
        'Lighthouse execution failed.',
        cause.stack,
      );

      throw new Error('Lighthouse execution failed.', {
        cause,
      });
    } finally {
      if (chrome) {
        try {
          chrome.kill();
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.error(`Failed to close Chrome: ${message}`);
        }
      }
    }
  }
}