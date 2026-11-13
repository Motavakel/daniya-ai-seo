import { Injectable, NotFoundException } from '@nestjs/common';
import { LighthouseReportsRepository } from '../../../infrastructure/database/repositories/lighthouse-reports.repository';
import { NetworkCapturesRepository } from '../../../infrastructure/database/repositories/network-captures.repository';
import { NetworkFindingsRepository } from '../../../infrastructure/database/repositories/network-findings.repository';
import { ReportsRepository } from '../../../infrastructure/database/repositories/reports.repository';
import { ScansRepository } from '../../../infrastructure/database/repositories/scans.repository';
import type { JsonObject } from '../../../infrastructure/database/schema/schema.types';

export type FinalScanStatus = 'completed' | 'completed_with_warnings';

@Injectable()
export class ReportFinalizerService {
  constructor(
    private readonly scans: ScansRepository,
    private readonly lighthouseReports: LighthouseReportsRepository,
    private readonly networkCaptures: NetworkCapturesRepository,
    private readonly networkFindings: NetworkFindingsRepository,
    private readonly reports: ReportsRepository,
  ) {}

  async finalize(scanId: string, status: FinalScanStatus): Promise<void> {
    const scan = await this.scans.findById(scanId);
    if (!scan) throw new NotFoundException('Scan not found.');

    const lighthouseReports = await this.lighthouseReports.listByScanId(scanId);
    const lighthouse = lighthouseReports[0];
    if (!lighthouse) {
      throw new Error('LIGHTHOUSE_RESULT_REQUIRED_FOR_FINAL_REPORT');
    }

    const networkRun = await this.networkCaptures.findLatestRunForScan(scanId);
    const findings = networkRun
      ? await this.networkFindings.listByNetworkRunId(networkRun.id)
      : [];

    const summary: JsonObject = {
      schemaVersion: '1.0.0',
      status,
      scan: {
        id: scan.id,
        profile: scan.profile,
        targetUrl: scan.targetUrl,
        hostname: scan.hostname,
        createdAt: scan.createdAt.toISOString(),
      },
      lighthouse: {
        reportId: lighthouse.id,
        performanceScore: lighthouse.performanceScore,
        accessibilityScore: lighthouse.accessibilityScore,
        bestPracticesScore: lighthouse.bestPracticesScore,
        seoScore: lighthouse.seoScore,
        firstContentfulPaintMs: lighthouse.firstContentfulPaintMs,
        largestContentfulPaintMs: lighthouse.largestContentfulPaintMs,
        speedIndexMs: lighthouse.speedIndexMs,
        totalBlockingTimeMs: lighthouse.totalBlockingTimeMs,
        cumulativeLayoutShift: lighthouse.cumulativeLayoutShift,
        timeToInteractiveMs: lighthouse.timeToInteractiveMs,
        totalByteWeightBytes: lighthouse.totalByteWeightBytes,
        networkRequests: lighthouse.networkRequests,
      },
      network: networkRun
        ? {
            networkRunId: networkRun.id,
            totalRequests: networkRun.totalRequests,
            failedRequests: networkRun.failedRequests,
            totalTransferredBytes: networkRun.totalTransferredBytes,
            totalEncodedBodyBytes: networkRun.totalEncodedBodyBytes,
            totalDecodedBodyBytes: networkRun.totalDecodedBodyBytes,
            observationDurationMs: networkRun.observationDurationMs,
          }
        : null,
      findingCounts: this.countBySeverity(findings),
      warning: status === 'completed_with_warnings'
        ? 'Network analysis did not complete fully. Lighthouse results remain available.'
        : null,
      generatedAt: new Date().toISOString(),
    };

    await this.reports.saveSnapshot({
      scanId,
      schemaVersion: '1.0.0',
      summary,
      findings: findings.map((finding) => ({
        engine: 'network',
        ruleId: finding.ruleId,
        ruleVersion: finding.ruleVersion,
        severity: finding.severity,
        title: finding.title,
        description: finding.description,
        evidence: finding.evidence,
        recommendation: finding.recommendation,
        affectedResourceCount: finding.affectedResourceCount,
        fingerprint: finding.fingerprint,
      })),
    });

    await this.scans.updateStatusIfCurrent({
      scanId,
      expectedStatuses: ['queued', 'running', 'network_queued', 'completed', 'completed_with_warnings'],
      status,
      completedAt: new Date(),
      errorCode: status === 'completed' ? null : scan.errorCode,
      errorMessage: status === 'completed' ? null : scan.errorMessage,
    });
  }

  private countBySeverity(findings: Array<{ severity: string }>): JsonObject {
    const counts: Record<string, number> = {
      info: 0,
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    for (const finding of findings) {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    }
    return counts;
  }
}
