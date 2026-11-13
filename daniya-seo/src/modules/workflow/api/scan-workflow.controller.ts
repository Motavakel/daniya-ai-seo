import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { LighthouseAuditsRepository } from '../../../infrastructure/database/repositories/lighthouse-audits.repository';
import { LighthouseReportsRepository } from '../../../infrastructure/database/repositories/lighthouse-reports.repository';
import { ReportsRepository } from '../../../infrastructure/database/repositories/reports.repository';
import { ReportArtifactsRepository } from '../../../infrastructure/database/repositories/report-artifacts.repository';
import { ScanWorkflowService } from '../application/scan-workflow.service';
import { GatewayContextGuard } from '../transport/gateway-context.guard';
import {
  isTrustedGatewayContext,
  type GatewayContextRequest,
} from '../transport/gateway-context';
import { CreateScanDto } from './dto/create-scan.dto';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Controller('internal/v1/scans')
@UseGuards(GatewayContextGuard)
export class ScanWorkflowController {
  constructor(
    private readonly workflow: ScanWorkflowService,
    private readonly reports: ReportsRepository,
    private readonly reportArtifacts: ReportArtifactsRepository,
    private readonly lighthouseReports: LighthouseReportsRepository,
    private readonly lighthouseAudits: LighthouseAuditsRepository,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async createScan(
    @Req() request: GatewayContextRequest,
    @Body() dto: CreateScanDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.workflow.createScan({
      targetUrl: dto.targetUrl,
      idempotencyKey: idempotencyKey?.trim() ?? null,
    });

    return {
      scanId: result.scan.id,
      status: result.scan.status,
      profile: result.scan.profile,
      created: result.created,
      createdAt: result.scan.createdAt,
    };
  }

  @Get(':scanId')
  async getScan(
    @Req() request: GatewayContextRequest,
    @Param('scanId', new ParseUUIDPipe({ version: '4' })) scanId: string,
  ) {
    const context = this.gatewayContext(request);
    const scan = await this.workflow.getScan(scanId, context.callerRef);
    return {
      id: scan.id,
      targetUrl: scan.targetUrl,
      hostname: scan.hostname,
      profile: scan.profile,
      strategy: scan.strategy,
      status: scan.status,
      errorCode: scan.errorCode,
      createdAt: scan.createdAt,
      startedAt: scan.startedAt,
      completedAt: scan.completedAt,
    };
  }

  @Get(':scanId/report')
  async getReport(
    @Req() request: GatewayContextRequest,
    @Param('scanId', new ParseUUIDPipe({ version: '4' })) scanId: string,
  ) {
    const context = this.gatewayContext(request);
    await this.workflow.getScan(scanId, context.callerRef);

    const report = await this.reports.findByScanId(scanId);
    if (!report) throw new ConflictException('The report is not ready yet.');

    const [lighthouseReportRows, artifacts] = await Promise.all([
      this.lighthouseReports.listByScanId(scanId),
      this.reportArtifacts.listByScanId(scanId),
    ]);
    const lighthouseReport = lighthouseReportRows[0];
    const audits = lighthouseReport
      ? await this.lighthouseAudits.listByReportId({
          reportId: lighthouseReport.id,
          limit: 1_000,
        })
      : [];

    return {
      id: report.id,
      schemaVersion: report.schemaVersion,
      generatedAt: report.generatedAt,
      summary: report.summary,
      findings: report.findings,
      lighthouse: lighthouseReport
        ? {
            reportId: lighthouseReport.id,
            reportVersion: lighthouseReport.lighthouseVersion,
            audits,
          }
        : null,
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        fileName: artifact.fileName,
        contentType: artifact.contentType,
        sizeBytes: artifact.sizeBytes,
        expiresAt: artifact.expiresAt,
      })),
    };
  }

  private gatewayContext(request: GatewayContextRequest) {
    if (!isTrustedGatewayContext(request.gatewayContext)) {
      throw new BadRequestException('Verified Gateway context is missing.');
    }
    return request.gatewayContext;
  }
}
