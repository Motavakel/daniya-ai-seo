import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ConfigModule } from '../src/core/config/config.module';
import { LighthouseProcessRunner } from '../src/modules/lighthouse/infrastructure/lighthouse-process.runner';

@Module({ imports: [ConfigModule], providers: [LighthouseProcessRunner] })
class LighthouseSmokeModule {}

async function main(): Promise<void> {
  const targetUrl = process.argv[2];
  if (!targetUrl) {
    throw new Error('Usage: npm run lighthouse:smoke -- https://example.com');
  }

  const app = await NestFactory.createApplicationContext(LighthouseSmokeModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const runner = app.get(LighthouseProcessRunner);
    const result = await runner.run(targetUrl);
    const outputDirectory = resolve(
      process.env.LIGHTHOUSE_SMOKE_OUTPUT_DIR ?? './var/lighthouse-smoke',
    );
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(outputDirectory, 'lighthouse.report.json'), result.json),
      writeFile(join(outputDirectory, 'lighthouse.report.html'), result.html),
    ]);

    const categories = result.lhr['categories'];
    const categoryScores: Record<string, number | null> = {};
    if (typeof categories === 'object' && categories !== null) {
      for (const [key, value] of Object.entries(categories)) {
        if (typeof value === 'object' && value !== null && 'score' in value) {
          const score = (value as { score?: unknown }).score;
          categoryScores[key] = typeof score === 'number' ? score : null;
        }
      }
    }

    const audits = result.lhr['audits'];
    const auditCount =
      typeof audits === 'object' && audits !== null
        ? Object.keys(audits).length
        : 0;

    process.stdout.write(
      `${JSON.stringify({
        success: true,
        lighthouseVersion: result.lhr['lighthouseVersion'] ?? null,
        requestedUrl: result.lhr['requestedUrl'] ?? null,
        finalUrl: result.lhr['finalDisplayedUrl'] ?? null,
        durationMs: result.durationMs,
        auditCount,
        categoryScores,
        outputDirectory,
      }, null, 2)}\n`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
