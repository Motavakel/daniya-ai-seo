import { Injectable } from '@nestjs/common';

interface NetLogEvent {
  type: number | string;
  source?: {
    id?: number | string;
  };
  time?: number | string;
  params?: Record<string, unknown>;
}

interface NetLogData {
  events: NetLogEvent[];
  constants?: {
    logEventTypes?: Record<string, number | string>;
  };
}

interface NetworkRequestRecord {
  sourceId: string;
  url: string | null;
  initialUrl: string | null;
  urlHistory: string[];
  redirects: string[];
  method: string | null;
  requestType: string | null;
  fetchDestination: string | null;
  fetchMode: string | null;
  referer: string | null;
  initiator: unknown;
  resourceType: string;
  status: number | null;
  mimeType: string | null;
  contentEncoding: string | null;
  contentLengthBytes: number | null;
  preFilterBodyBytes: number;
  postFilterBodyBytes: number;
  rawReadEvents: number;
  filteredReadEvents: number;
  failed: boolean;
  netError: number | string | null;
  startTick: number | null;
  endTick: number | null;
  sizeBytes: number | null;
  sizeSource: string;
  durationMs: number | null;
  redirectCount: number;
  offsetFromFirstRequestMs: number | null;
}

export interface NetworkParserOptions {
  targetUrl: string;
  observationSeconds: number;
  navigationWarning: string | null;
  rawNetLogBytes: number;
}

export interface NetworkReport {
  meta: {
    targetUrl: string;
    analyzedAt: string;
    rawNetLogBytes: number;
    rawEventCount: number;
    observationSeconds: number;
    navigationWarning: string | null;
  };
  summary: {
    totalRequests: number;
    requestsWithSize: number;
    requestsWithoutSize: number;
    failedRequests: number;
    redirectedRequests: number;
    measuredBodyRequests: number;
    contentLengthFallbackRequests: number;
    measuredBodyBytes: number;
    measuredBodySize: string;
    fallbackBytes: number;
    fallbackSize: string;
  };
  eventCounts: {
    URL_REQUEST_START_JOB: number;
    URL_REQUEST_REDIRECTED: number;
    URL_REQUEST_JOB_BYTES_READ: number;
    URL_REQUEST_JOB_FILTERED_BYTES_READ: number;
    requestHeaderEvents: number;
    responseHeaderEvents: number;
  };
  requests: NetworkRequestRecord[];
  topRequests: NetworkRequestRecord[];
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) {
    return 'Unknown';
  }

  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function headerLines(headers: unknown): string[] {
  if (!headers) return [];

  if (typeof headers === 'string') {
    return headers.split(/\r?\n/).filter(Boolean);
  }

  if (Array.isArray(headers)) {
    return headers.flatMap((item) => {
      if (typeof item === 'string') {
        return item.split(/\r?\n/).filter(Boolean);
      }

      if (item && typeof item === 'object') {
        const header = item as Record<string, unknown>;

        return [`${header.name ?? ''}: ${header.value ?? ''}`];
      }

      return [];
    });
  }

  if (typeof headers === 'object') {
    const headerObject = headers as Record<string, unknown>;

    if (Array.isArray(headerObject.headers)) {
      return headerLines(headerObject.headers);
    }

    return Object.entries(headerObject).map(
      ([key, value]) => `${key}: ${String(value)}`,
    );
  }

  return [];
}

function readHeaders(
  record: NetworkRequestRecord,
  headers: unknown,
  kind: 'request' | 'response',
): void {
  for (const line of headerLines(headers)) {
    const status =
      line.match(/^HTTP\/\S+\s+(\d{3})/i) ||
      line.match(/^:status:\s*(\d{3})/i);

    if (kind === 'response' && status) {
      record.status = Number(status[1]);
      continue;
    }

    const colon = line.indexOf(':');

    if (colon < 1) continue;

    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (kind === 'request') {
      if (name === 'sec-fetch-dest') {
        record.fetchDestination = value;
      }

      if (name === 'sec-fetch-mode') {
        record.fetchMode = value;
      }

      if (name === 'referer') {
        record.referer = value;
      }
    } else {
      if (name === 'content-type') {
        record.mimeType = value.split(';')[0].trim();
      }

      if (name === 'content-encoding') {
        record.contentEncoding = value;
      }

      if (name === 'content-length') {
        record.contentLengthBytes = numberOrNull(value);
      }
    }
  }
}

function inferResourceType(record: NetworkRequestRecord): string {
  const dest = String(record.fetchDestination || '').toLowerCase();
  const requestType = String(record.requestType || '').toLowerCase();
  const mime = String(record.mimeType || '').toLowerCase();

  const url = String(record.url || '')
    .toLowerCase()
    .split(/[?#]/)[0];

  const destinations: Record<string, string> = {
    document: 'document',
    iframe: 'iframe',
    image: 'image',
    script: 'script',
    style: 'stylesheet',
    font: 'font',
    audio: 'audio',
    video: 'video',
    track: 'track',
    worker: 'worker',
    sharedworker: 'shared_worker',
    serviceworker: 'service_worker',
    object: 'object',
    embed: 'embed',
  };

  if (dest && dest !== 'empty' && destinations[dest]) {
    return destinations[dest];
  }

  if (requestType === 'main frame') return 'document';
  if (requestType === 'subframe') return 'iframe';

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('font/')) return 'font';
  if (mime.includes('text/css')) return 'stylesheet';

  if (
    mime.includes('javascript') ||
    mime.includes('ecmascript')
  ) {
    return 'script';
  }

  if (mime.includes('text/html')) return 'document';
  if (mime.includes('json')) return 'fetch/xhr';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';

  const extensions: Record<string, string> = {
    '.js': 'script',
    '.mjs': 'script',
    '.css': 'stylesheet',
    '.woff': 'font',
    '.woff2': 'font',
    '.ttf': 'font',
    '.otf': 'font',
    '.eot': 'font',
    '.png': 'image',
    '.jpg': 'image',
    '.jpeg': 'image',
    '.gif': 'image',
    '.webp': 'image',
    '.avif': 'image',
    '.svg': 'image',
    '.ico': 'image',
    '.mp4': 'video',
    '.webm': 'video',
    '.mp3': 'audio',
    '.wav': 'audio',
  };

  for (const [extension, type] of Object.entries(extensions)) {
    if (url.endsWith(extension)) return type;
  }

  return record.fetchMode === 'cors' ? 'fetch/xhr' : 'other';
}

@Injectable()
export class NetworkParser {
  parse(
    input: unknown,
    options: NetworkParserOptions,
  ): NetworkReport {
    if (!input || typeof input !== 'object') {
      throw new Error('Invalid NetLog data.');
    }

    const netlog = input as NetLogData;

    if (!Array.isArray(netlog.events)) {
      throw new Error('NetLog events array is missing.');
    }

    const eventTypes = netlog.constants?.logEventTypes;

    if (!eventTypes) {
      throw new Error('NetLog event type constants are missing.');
    }

    const eventNames = new Map(
      Object.entries(eventTypes).map(([name, id]) => [
        Number(id),
        name,
      ]),
    );

    const nameOf = (event: NetLogEvent) =>
      eventNames.get(Number(event.type));

    const requestSourceIds = new Set<string>();

    for (const event of netlog.events) {
      if (
        nameOf(event) === 'URL_REQUEST_START_JOB' &&
        event.source?.id != null
      ) {
        requestSourceIds.add(String(event.source.id));
      }
    }

    const records = new Map<string, NetworkRequestRecord>();

    const eventCounts = {
      URL_REQUEST_START_JOB: 0,
      URL_REQUEST_REDIRECTED: 0,
      URL_REQUEST_JOB_BYTES_READ: 0,
      URL_REQUEST_JOB_FILTERED_BYTES_READ: 0,
      requestHeaderEvents: 0,
      responseHeaderEvents: 0,
    };

    let firstRequestTick: number | null = null;

    const getRecord = (sourceId: string): NetworkRequestRecord => {
      if (!records.has(sourceId)) {
        records.set(sourceId, {
          sourceId,
          url: null,
          initialUrl: null,
          urlHistory: [],
          redirects: [],
          method: null,
          requestType: null,
          fetchDestination: null,
          fetchMode: null,
          referer: null,
          initiator: null,
          resourceType: 'unknown',
          status: null,
          mimeType: null,
          contentEncoding: null,
          contentLengthBytes: null,
          preFilterBodyBytes: 0,
          postFilterBodyBytes: 0,
          rawReadEvents: 0,
          filteredReadEvents: 0,
          failed: false,
          netError: null,
          startTick: null,
          endTick: null,
          sizeBytes: null,
          sizeSource: 'unknown',
          durationMs: null,
          redirectCount: 0,
          offsetFromFirstRequestMs: null,
        });
      }

      return records.get(sourceId)!;
    };

    const appendUrl = (
      record: NetworkRequestRecord,
      url: unknown,
    ) => {
      if (typeof url !== 'string' || !url) return;

      if (record.urlHistory.at(-1) !== url) {
        record.urlHistory.push(url);
      }

      if (!record.initialUrl) {
        record.initialUrl = url;
      }

      record.url = url;
    };

    for (const event of netlog.events) {
      const sourceId = event.source?.id;

      if (
        sourceId == null ||
        !requestSourceIds.has(String(sourceId))
      ) {
        continue;
      }

      const eventName = nameOf(event);

      if (!eventName) continue;

      const params = event.params ?? {};
      const record = getRecord(String(sourceId));
      const tick = numberOrNull(event.time);

      if (tick !== null) {
        if (record.startTick === null || tick < record.startTick) {
          record.startTick = tick;
        }

        if (record.endTick === null || tick > record.endTick) {
          record.endTick = tick;
        }

        if (firstRequestTick === null || tick < firstRequestTick) {
          firstRequestTick = tick;
        }
      }

      switch (eventName) {
        case 'URL_REQUEST_START_JOB': {
          eventCounts.URL_REQUEST_START_JOB++;

          appendUrl(record, params.url);

          record.method = stringOrNull(params.method) ?? record.method;
          record.requestType =
            stringOrNull(params.request_type) ?? record.requestType;
          record.initiator = params.initiator ?? record.initiator;

          if (
            params.net_error != null &&
            Number(params.net_error) !== 0
          ) {
            record.failed = true;
            record.netError = params.net_error as number | string;
          }

          break;
        }

        case 'URL_REQUEST_REDIRECTED': {
          eventCounts.URL_REQUEST_REDIRECTED++;

          if (typeof params.location === 'string') {
            record.redirects.push(params.location);
            appendUrl(record, params.location);
          }

          break;
        }

        case 'URL_REQUEST_JOB_BYTES_READ': {
          eventCounts.URL_REQUEST_JOB_BYTES_READ++;

          const bytes = numberOrNull(params.byte_count);

          if (bytes !== null && bytes > 0) {
            record.preFilterBodyBytes += bytes;
            record.rawReadEvents++;
          }

          break;
        }

        case 'URL_REQUEST_JOB_FILTERED_BYTES_READ': {
          eventCounts.URL_REQUEST_JOB_FILTERED_BYTES_READ++;

          const bytes = numberOrNull(params.byte_count);

          if (bytes !== null && bytes > 0) {
            record.postFilterBodyBytes += bytes;
            record.filteredReadEvents++;
          }

          break;
        }

        case 'HTTP_TRANSACTION_SEND_REQUEST_HEADERS':
        case 'HTTP_TRANSACTION_QUIC_SEND_REQUEST_HEADERS': {
          eventCounts.requestHeaderEvents++;

          readHeaders(record, params.headers, 'request');

          break;
        }

        case 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS':
        case 'HTTP_TRANSACTION_READ_TUNNEL_RESPONSE_HEADERS':
        case 'URL_REQUEST_FAKE_RESPONSE_HEADERS_CREATED': {
          eventCounts.responseHeaderEvents++;

          readHeaders(record, params.headers, 'response');

          break;
        }

        case 'FAILED':
        case 'CANCELLED': {
          record.failed = true;

          if (params.net_error != null) {
            record.netError = params.net_error as number | string;
          }

          break;
        }

        default: {
          if (
            eventName.includes('READ_RESPONSE_HEADERS') &&
            params.headers
          ) {
            readHeaders(record, params.headers, 'response');
          }

          if (
            params.net_error != null &&
            Number(params.net_error) !== 0
          ) {
            record.failed = true;
            record.netError = params.net_error as number | string;
          }
        }
      }
    }

    const requests = [...records.values()].map((record) => {
      // Pre-filter and post-filter bytes must never be added together.
      if (record.preFilterBodyBytes > 0) {
        record.sizeBytes = record.preFilterBodyBytes;
        record.sizeSource = 'netlog-prefilter-body';
      } else if (record.postFilterBodyBytes > 0) {
        record.sizeBytes = record.postFilterBodyBytes;
        record.sizeSource = 'netlog-postfilter-body';
      } else if (record.contentLengthBytes !== null) {
        record.sizeBytes = record.contentLengthBytes;
        record.sizeSource = 'content-length-fallback';
      }

      record.resourceType = inferResourceType(record);

      record.durationMs =
        record.startTick !== null && record.endTick !== null
          ? Math.max(0, record.endTick - record.startTick)
          : null;

      record.redirectCount = record.redirects.length;

      record.offsetFromFirstRequestMs =
        record.startTick !== null && firstRequestTick !== null
          ? Math.max(0, record.startTick - firstRequestTick)
          : null;

      return record;
    });

    const sorted = requests.sort(
      (a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1),
    );

    const withSize = sorted.filter(
      (record) => record.sizeBytes !== null,
    );

    const measured = sorted.filter(
      (record) => record.sizeSource.startsWith('netlog-'),
    );

    const fallback = sorted.filter(
      (record) => record.sizeSource === 'content-length-fallback',
    );

    const measuredBytes = measured.reduce(
      (sum, record) => sum + (record.sizeBytes ?? 0),
      0,
    );

    const fallbackBytes = fallback.reduce(
      (sum, record) => sum + (record.sizeBytes ?? 0),
      0,
    );

    return {
      meta: {
        targetUrl: options.targetUrl,
        analyzedAt: new Date().toISOString(),
        rawNetLogBytes: options.rawNetLogBytes,
        rawEventCount: netlog.events.length,
        observationSeconds: options.observationSeconds,
        navigationWarning: options.navigationWarning,
      },

      summary: {
        totalRequests: sorted.length,
        requestsWithSize: withSize.length,
        requestsWithoutSize: sorted.length - withSize.length,

        failedRequests: sorted.filter(
          (record) => record.failed,
        ).length,

        redirectedRequests: sorted.filter(
          (record) => record.redirectCount > 0,
        ).length,

        measuredBodyRequests: measured.length,
        contentLengthFallbackRequests: fallback.length,

        measuredBodyBytes: measuredBytes,
        measuredBodySize: formatBytes(measuredBytes),

        fallbackBytes,
        fallbackSize: formatBytes(fallbackBytes),
      },

      eventCounts,

      requests: sorted,
      topRequests: withSize.slice(0, 30),
    };
  }
}