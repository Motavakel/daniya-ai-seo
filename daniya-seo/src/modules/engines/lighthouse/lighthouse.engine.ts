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
          kill: () => Promise<void>;
        }
      | undefined;

    try {
      const chromeLauncher = await import('chrome-launcher');
      const lighthouseModule = await import('lighthouse');

      const chromeFlags = ['--headless=new'];

      if (this.config.get<string>('CHROME_NO_SANDBOX') === 'true') {
        chromeFlags.push('--no-sandbox', '--disable-setuid-sandbox');
      }

      const chromePath = this.config.get<string>('CHROME_PATH');

      chrome = await chromeLauncher.launch({
        ...(chromePath ? { chromePath } : {}),
        chromeFlags,
        handleSIGINT: false,
        logLevel: 'error',
      });

      const result = await lighthouseModule.default(targetUrl, {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
      });

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
          await chrome.kill();
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.error(`Failed to close Chrome: ${message}`);
        }
      }
    }
  }
}