import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NetLogParser } from '../src/modules/network/domain/netlog-parser';

async function main(): Promise<void> {
  const fixturePath = resolve(process.cwd(), 'tests/fixtures/netlog-minimal.json');
  const fixture = await readFile(fixturePath);
  const parser = new NetLogParser();
  const result = parser.parse(fixture, {
    captureStartedAt: new Date('2026-11-01T10:00:00.000Z'),
    captureFinishedAt: new Date('2026-11-01T10:00:01.000Z'),
    chromeVersion: '156.0.0.0',
    targetHostname: 'example.com',
  });

  assert.equal(result.requests.length, 1, 'expected one parsed URL_REQUEST');
  const request = result.requests[0];
  assert.ok(request, 'parsed request is missing');
  assert.equal(request.statusCode, 200);
  assert.equal(request.resourceType, 'document');
  assert.equal(request.durationMs, '50.000');
  assert.equal(request.url.includes('do-not-store'), false, 'secret query values must be redacted');
  assert.equal(request.transferredBytes, null, 'unobserved byte metrics must remain null');
  assert.equal(request.fieldAvailability['transferredBytes'], 'not_observed');

  process.stdout.write('NetLog parser smoke test passed.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
