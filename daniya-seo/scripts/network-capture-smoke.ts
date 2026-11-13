import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { ChromeNetLogRunner } from '../src/modules/network/infrastructure/chrome-netlog.runner';
import { NetLogParser } from '../src/modules/network/domain/netlog-parser';
import { TargetUrlValidator } from '../src/modules/security/target-url.validator';

async function main(): Promise<void> {
  const targetUrl = process.argv[2] ?? 'https://example.com';
  const config = new ConfigService({
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    CHROME_PATH: process.env.CHROME_PATH,
    CHROME_NO_SANDBOX: process.env.CHROME_NO_SANDBOX === 'true',
    BROWSER_PROXY_URL: process.env.BROWSER_PROXY_URL,
    NETWORK_OBSERVATION_MS: process.env.NETWORK_OBSERVATION_MS ?? '20000',
    NETWORK_NETLOG_MAX_BYTES: process.env.NETWORK_NETLOG_MAX_BYTES ?? '104857600',
  });

  const runner = new ChromeNetLogRunner(config, new TargetUrlValidator());
  const capture = await runner.run(targetUrl);
  const parsed = new NetLogParser().parse(capture.netlog, {
    captureStartedAt: capture.captureStartedAt,
    captureFinishedAt: capture.captureFinishedAt,
    chromeVersion: capture.chromeVersion,
    targetHostname: new URL(targetUrl).hostname,
  });

  process.stdout.write(`${JSON.stringify({
    chromeVersion: parsed.chromeVersion,
    netlogVersion: parsed.netlogVersion,
    eventCount: parsed.eventCount,
    requestCount: parsed.requests.length,
    observationDurationMs: capture.observationDurationMs,
    byteMetricsAvailable: parsed.requests.some((request) =>
      request.transferredBytes !== null ||
      request.encodedBodyBytes !== null ||
      request.decodedBodyBytes !== null,
    ),
  }, null, 2)}\n`);

  if (parsed.requests.length === 0) {
    throw new Error('NETWORK_CAPTURE_RETURNED_NO_URL_REQUESTS');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
