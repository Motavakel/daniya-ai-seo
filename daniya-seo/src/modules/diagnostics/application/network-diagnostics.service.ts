import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NetworkCapturesRepository } from '../../../infrastructure/database/repositories/network-captures.repository';
import { NetworkFindingsRepository } from '../../../infrastructure/database/repositories/network-findings.repository';
import { NetworkDiagnosticEngine } from '../domain/network-diagnostic.engine';

@Injectable()
export class NetworkDiagnosticsService {
  constructor(
    private readonly captures: NetworkCapturesRepository,
    private readonly findings: NetworkFindingsRepository,
    private readonly engine: NetworkDiagnosticEngine,
    private readonly config: ConfigService,
  ) {}

  async analyze(networkRunId: string): Promise<{ findingCount: number }> {
    const run = await this.captures.findRunById(networkRunId);
    if (!run) throw new NotFoundException('Network run not found.');

    const rawLimit = this.config.get<string | number>('NETWORK_DIAGNOSTIC_MAX_REQUESTS', 20_000);
    const configuredLimit = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit);
    const maxRows = Number.isInteger(configuredLimit)
      ? Math.min(Math.max(configuredLimit, 100), 20_000)
      : 20_000;
    const requests = await this.captures.listAllRequestsForDiagnostics(networkRunId, maxRows);
    const findings = this.engine.evaluate(requests);
    const saved = await this.findings.replaceForRun(networkRunId, findings);
    return { findingCount: saved.length };
  }
}
