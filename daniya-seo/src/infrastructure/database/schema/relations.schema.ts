import { relations } from 'drizzle-orm';
import { lighthouseAudits } from './lighthouse-audits.schema';
import { lighthouseReports } from './lighthouse-reports.schema';
import { networkRequests } from './network-requests.schema';
import { networkRuns } from './network-runs.schema';
import { networkFindings } from './network-findings.schema';
import { outboxEvents } from './outbox-events.schema';
import { reportArtifacts } from './report-artifacts.schema';
import { reportFindings, reports } from './reports.schema';
import { scanEngineRuns } from './scan-engine-runs.schema';
import { scans } from './scans.schema';

export const scansRelations = relations(scans, ({ many, one }) => ({
  engineRuns: many(scanEngineRuns),
  lighthouseReports: many(lighthouseReports),
  networkRuns: many(networkRuns),
  report: one(reports, {
    fields: [scans.id],
    references: [reports.scanId],
  }),
  artifacts: many(reportArtifacts),
  outboxEvents: many(outboxEvents),
}));

export const scanEngineRunsRelations = relations(
  scanEngineRuns,
  ({ one, many }) => ({
    scan: one(scans, {
      fields: [scanEngineRuns.scanId],
      references: [scans.id],
    }),
    lighthouseReport: one(lighthouseReports, {
      fields: [scanEngineRuns.id],
      references: [lighthouseReports.engineRunId],
    }),
    networkRun: one(networkRuns, {
      fields: [scanEngineRuns.id],
      references: [networkRuns.engineRunId],
    }),
    artifacts: many(reportArtifacts),
  }),
);

export const lighthouseReportsRelations = relations(
  lighthouseReports,
  ({ one, many }) => ({
    scan: one(scans, {
      fields: [lighthouseReports.scanId],
      references: [scans.id],
    }),
    engineRun: one(scanEngineRuns, {
      fields: [lighthouseReports.engineRunId],
      references: [scanEngineRuns.id],
    }),
    audits: many(lighthouseAudits),
  }),
);

export const lighthouseAuditsRelations = relations(
  lighthouseAudits,
  ({ one }) => ({
    report: one(lighthouseReports, {
      fields: [lighthouseAudits.reportId],
      references: [lighthouseReports.id],
    }),
  }),
);

export const networkRunsRelations = relations(networkRuns, ({ one, many }) => ({
  scan: one(scans, {
    fields: [networkRuns.scanId],
    references: [scans.id],
  }),
  engineRun: one(scanEngineRuns, {
    fields: [networkRuns.engineRunId],
    references: [scanEngineRuns.id],
  }),
  requests: many(networkRequests),
  findings: many(networkFindings),
}));

export const networkRequestsRelations = relations(
  networkRequests,
  ({ one, many }) => ({
    networkRun: one(networkRuns, {
      fields: [networkRequests.networkRunId],
      references: [networkRuns.id],
    }),
    findings: many(networkFindings),
  }),
);

export const networkFindingsRelations = relations(
  networkFindings,
  ({ one }) => ({
    networkRun: one(networkRuns, {
      fields: [networkFindings.networkRunId],
      references: [networkRuns.id],
    }),
    request: one(networkRequests, {
      fields: [networkFindings.requestId],
      references: [networkRequests.id],
    }),
  }),
);

export const reportsRelations = relations(reports, ({ one, many }) => ({
  scan: one(scans, {
    fields: [reports.scanId],
    references: [scans.id],
  }),
  findings: many(reportFindings),
  artifacts: many(reportArtifacts),
}));

export const reportFindingsRelations = relations(reportFindings, ({ one }) => ({
  report: one(reports, {
    fields: [reportFindings.reportId],
    references: [reports.id],
  }),
}));

export const reportArtifactsRelations = relations(
  reportArtifacts,
  ({ one }) => ({
    scan: one(scans, {
      fields: [reportArtifacts.scanId],
      references: [scans.id],
    }),
    engineRun: one(scanEngineRuns, {
      fields: [reportArtifacts.engineRunId],
      references: [scanEngineRuns.id],
    }),
    report: one(reports, {
      fields: [reportArtifacts.reportId],
      references: [reports.id],
    }),
  }),
);

export const outboxEventsRelations = relations(outboxEvents, ({ one }) => ({
  scan: one(scans, {
    fields: [outboxEvents.scanId],
    references: [scans.id],
  }),
}));
