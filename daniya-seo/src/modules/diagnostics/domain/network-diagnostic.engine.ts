import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { NetworkRequestRow } from '../../../infrastructure/database/repositories/network-captures.repository';
import type { NetworkFindingInsert } from '../../../infrastructure/database/repositories/network-findings.repository';
import type { JsonObject } from '../../../infrastructure/database/schema/schema.types';

const RULE_VERSION = '1.0.0';
const STATIC_TYPES = new Set(['stylesheet', 'script', 'image', 'font']);

function makeFingerprint(ruleId: string, parts: string[]): string {
  return createHash('sha256')
    .update(`${ruleId}:${[...parts].sort().join('|')}`)
    .digest('hex');
}

function parseDeclaredContentLength(request: NetworkRequestRow): number | null {
  const raw = request.responseHeaders['content-length'];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

@Injectable()
export class NetworkDiagnosticEngine {
  evaluate(
    requests: NetworkRequestRow[],
    options?: { slowRequestThresholdMs?: number; largeResourceThresholdBytes?: number; highRequestCountThreshold?: number },
  ): NetworkFindingInsert[] {
    const findings: NetworkFindingInsert[] = [];
    const slowThreshold = options?.slowRequestThresholdMs ?? 1_500;
    const largeThreshold = options?.largeResourceThresholdBytes ?? 512 * 1024;
    const highCountThreshold = options?.highRequestCountThreshold ?? 80;

    const failed = requests.filter(
      (request) => Boolean(request.failureCode) || (request.statusCode != null && request.statusCode >= 400),
    );
    if (failed.length > 0) {
      const serverErrors = failed.filter((request) => (request.statusCode ?? 0) >= 500);
      findings.push({
        requestId: null,
        ruleId: 'network.failed_requests',
        ruleVersion: RULE_VERSION,
        severity: serverErrors.length > 0 ? 'high' : 'medium',
        title: 'درخواست‌های ناموفق',
        description: 'در زمان بررسی، بخشی از درخواست‌های شبکه با خطای HTTP یا خطای شبکه مواجه شده‌اند.',
        evidence: {
          failedCount: failed.length,
          serverErrorCount: serverErrors.length,
          samples: failed.slice(0, 10).map((request) => ({
            url: request.url,
            statusCode: request.statusCode,
            failureCode: request.failureCode,
          })),
        } as JsonObject,
        recommendation: 'درخواست‌های نمونه را در Network و لاگ سرور بررسی کنید؛ خطای شبکه، پاسخ 4xx و خطای 5xx علت‌های متفاوتی دارند.',
        affectedResourceCount: failed.length,
        fingerprint: makeFingerprint('network.failed_requests', failed.map((request) => request.urlHash ?? String(request.id))),
      });
    }

    const slow = requests.filter(
      (request) => request.durationMs !== null && Number(request.durationMs) >= slowThreshold,
    );
    if (slow.length > 0) {
      findings.push({
        requestId: null,
        ruleId: 'network.slow_requests',
        ruleVersion: RULE_VERSION,
        severity: slow.some((request) => Number(request.durationMs) >= slowThreshold * 3) ? 'high' : 'medium',
        title: 'درخواست‌های با زمان پاسخ طولانی',
        description: `تعدادی از درخواست‌ها بیش از ${slowThreshold} میلی‌ثانیه در چرخه ثبت‌شده زمان برده‌اند.`,
        evidence: {
          thresholdMs: slowThreshold,
          slowCount: slow.length,
          samples: slow
            .sort((a, b) => Number(b.durationMs) - Number(a.durationMs))
            .slice(0, 10)
            .map((request) => ({ url: request.url, durationMs: Number(request.durationMs) })),
        } as JsonObject,
        recommendation: 'برای درخواست‌های کند، زمان پاسخ سرور، DNS، TLS و حجم پاسخ را جداگانه بررسی کنید. NetLog فعلی لزوماً همه این فازها را برای هر درخواست ارائه نمی‌کند.',
        affectedResourceCount: slow.length,
        fingerprint: makeFingerprint('network.slow_requests', slow.map((request) => request.urlHash ?? String(request.id))),
      });
    }

    const large = requests
      .map((request) => ({
        request,
        bytes: request.decodedBodyBytes ?? request.encodedBodyBytes ?? request.transferredBytes ?? parseDeclaredContentLength(request),
        source: request.decodedBodyBytes !== null
          ? 'decoded_body_bytes'
          : request.encodedBodyBytes !== null
            ? 'encoded_body_bytes'
            : request.transferredBytes !== null
              ? 'transferred_bytes'
              : 'content_length_header',
      }))
      .filter((item) => item.bytes !== null && item.bytes >= largeThreshold);
    if (large.length > 0) {
      findings.push({
        requestId: null,
        ruleId: 'network.large_resources',
        ruleVersion: RULE_VERSION,
        severity: large.some((item) => (item.bytes ?? 0) >= largeThreshold * 4) ? 'high' : 'medium',
        title: 'منابع با حجم پاسخ بالا',
        description: 'چند منبع از آستانه حجم تعیین‌شده بزرگ‌تر هستند. در صورت استفاده از Content-Length، عدد گزارش‌شده طول اعلام‌شده پاسخ است، نه اندازه قطعی انتقال.',
        evidence: {
          thresholdBytes: largeThreshold,
          resourceCount: large.length,
          samples: large
            .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
            .slice(0, 10)
            .map((item) => ({ url: item.request.url, bytes: item.bytes, measurement: item.source })),
        } as JsonObject,
        recommendation: 'تصاویر را به ابعاد نمایش واقعی محدود و فشرده کنید؛ برای JavaScript و CSS نیز حذف کد بلااستفاده و تقسیم مناسب فایل‌ها را بررسی کنید.',
        affectedResourceCount: large.length,
        fingerprint: makeFingerprint('network.large_resources', large.map((item) => item.request.urlHash ?? String(item.request.id))),
      });
    }

    const staticGroups = new Map<string, NetworkRequestRow[]>();
    for (const request of requests) {
      if (!STATIC_TYPES.has(request.resourceType) || request.method !== 'GET' || !request.urlHash) continue;
      const group = staticGroups.get(request.urlHash) ?? [];
      group.push(request);
      staticGroups.set(request.urlHash, group);
    }
    const repeated = [...staticGroups.values()].filter((group) => group.length >= 3);
    if (repeated.length > 0) {
      findings.push({
        requestId: null,
        ruleId: 'network.repeated_static_request_candidates',
        ruleVersion: RULE_VERSION,
        severity: 'info',
        title: 'نامزدهای درخواست تکراری منابع ثابت',
        description: 'یک منبع ثابت در یک Capture حداقل سه بار با URL و Method یکسان دیده شده است. این مورد به‌تنهایی اثبات اشکال نیست و ممکن است به چند سند، فریم یا رفتار معتبر صفحه مربوط باشد.',
        evidence: {
          candidateCount: repeated.length,
          groups: repeated.slice(0, 10).map((group) => ({
            url: group[0]?.url ?? null,
            count: group.length,
            resourceType: group[0]?.resourceType ?? 'unknown',
          })),
        } as JsonObject,
        recommendation: 'Initiator و ساختار DOM را بررسی کنید و فقط در صورت تأیید بارگذاری غیرضروری، فراخوانی تکراری را حذف یا Cache را اصلاح کنید.',
        affectedResourceCount: repeated.reduce((sum, group) => sum + group.length, 0),
        fingerprint: makeFingerprint('network.repeated_static_request_candidates', repeated.map((group) => group[0]?.urlHash ?? 'unknown')),
      });
    }

    const noStore = requests.filter((request) =>
      STATIC_TYPES.has(request.resourceType) &&
      request.cacheControl !== null &&
      /\bno-store\b/i.test(request.cacheControl),
    );
    if (noStore.length > 0) {
      findings.push({
        requestId: null,
        ruleId: 'network.static_assets_no_store',
        ruleVersion: RULE_VERSION,
        severity: 'low',
        title: 'غیرفعال بودن ذخیره‌سازی Cache برای منابع ثابت',
        description: 'برای برخی منابع ثابت، هدر Cache-Control شامل no-store است.',
        evidence: {
          resourceCount: noStore.length,
          samples: noStore.slice(0, 10).map((request) => ({ url: request.url, cacheControl: request.cacheControl })),
        } as JsonObject,
        recommendation: 'برای فایل‌های نسخه‌دار CSS، JavaScript، تصویر و فونت، سیاست Cache متناسب با عمر فایل تعریف کنید. برای محتوای شخصی یا حساس، no-store را حفظ کنید.',
        affectedResourceCount: noStore.length,
        fingerprint: makeFingerprint('network.static_assets_no_store', noStore.map((request) => request.urlHash ?? String(request.id))),
      });
    }

    if (requests.length > highCountThreshold) {
      findings.push({
        requestId: null,
        ruleId: 'network.high_request_count',
        ruleVersion: RULE_VERSION,
        severity: requests.length > highCountThreshold * 2 ? 'medium' : 'info',
        title: 'تعداد بالای درخواست‌های شبکه',
        description: `در Capture فعلی ${requests.length} درخواست ثبت شده است که از آستانه ${highCountThreshold} بیشتر است.`,
        evidence: {
          totalRequests: requests.length,
          threshold: highCountThreshold,
          resourceTypeCounts: this.countBy(requests, (request) => request.resourceType),
          hostCounts: this.countBy(requests, (request) => request.hostname),
        } as JsonObject,
        recommendation: 'درخواست‌های غیرضروری، افزونه‌ها، اسکریپت‌های ثالث و منابع تکراری را بررسی کنید. تعداد بالا به‌تنهایی به معنی کندی قطعی نیست.',
        affectedResourceCount: requests.length,
        fingerprint: makeFingerprint('network.high_request_count', [String(requests.length), ...requests.map((request) => request.hostname)]),
      });
    }

    return findings;
  }

  private countBy<T>(items: T[], keySelector: (item: T) => string): JsonObject {
    const counts: Record<string, number> = {};
    for (const item of items) {
      const key = keySelector(item).slice(0, 253) || 'unknown';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }
}
