import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  FieldAvailability,
  JsonObject,
  SafeResponseHeaders,
} from '../../../infrastructure/database/schema/schema.types';
import type { CreateNetworkRequestInput } from '../../../infrastructure/database/repositories/network-captures.repository';

const PARSER_VERSION = '1.0.0';
const ALLOWED_HEADERS = new Set([
  'cache-control',
  'age',
  'etag',
  'last-modified',
  'content-encoding',
  'vary',
  'content-type',
  'content-length',
  'server',
  'x-cache',
  'cf-cache-status',
]);
const SECRET_QUERY_KEY_PATTERN = /(^|[_-])(access[_-]?token|auth(?:orization)?|token|api[_-]?key|secret|password|passwd|session|signature|credential|refresh[_-]?token)([_-]|$)/i;

type UnknownRecord = Record<string, unknown>;

interface NetLogEvent {
  time?: string | number;
  type?: string | number;
  phase?: string | number;
  source?: UnknownRecord;
  params?: UnknownRecord;
}

interface NetLogDump {
  constants?: UnknownRecord;
  events?: unknown[];
  [key: string]: unknown;
}

export interface ParsedNetworkCapture {
  requests: CreateNetworkRequestInput[];
  eventCount: number;
  chromeVersion: string | null;
  netlogVersion: string | null;
  captureContext: JsonObject;
}

interface RequestHop {
  begin: NetLogEvent;
  end?: NetLogEvent;
  url: string;
  method: string;
  redirectLocation?: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function reverseEnum(value: unknown): Map<number, string> {
  const result = new Map<number, string>();
  if (!isRecord(value)) return result;
  for (const [name, numeric] of Object.entries(value)) {
    const parsed = readNumber(numeric);
    if (parsed !== null) result.set(parsed, name);
  }
  return result;
}

function sanitizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEY_PATTERN.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    url.hash = '';
    return url.toString().slice(0, 4_096);
  } catch {
    return null;
  }
}

function headerLines(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\r?\n/);
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`);
  }
  return [];
}

function parseResponseHeaders(params: UnknownRecord): {
  statusCode: number | null;
  headers: SafeResponseHeaders;
} {
  const raw = params['headers'] ?? params['response_headers'];
  const lines = headerLines(raw);
  const headers: SafeResponseHeaders = {};
  let statusCode: number | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const statusMatch = trimmed.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
    if (statusMatch?.[1]) {
      statusCode = Number(statusMatch[1]);
      continue;
    }

    if (/^:status\s*:/i.test(trimmed)) {
      const statusValue = trimmed.slice(trimmed.indexOf(':', 1) + 1).trim();
      const parsedStatus = Number(statusValue);
      if (Number.isInteger(parsedStatus) && parsedStatus >= 100 && parsedStatus <= 599) {
        statusCode = parsedStatus;
      }
      continue;
    }

    const separator = trimmed.indexOf(':');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim().slice(0, 1_024);
    if (!ALLOWED_HEADERS.has(key)) continue;

    switch (key) {
      case 'cache-control': headers['cache-control'] = value; break;
      case 'age': headers.age = value; break;
      case 'etag': headers.etag = value; break;
      case 'last-modified': headers['last-modified'] = value; break;
      case 'content-encoding': headers['content-encoding'] = value; break;
      case 'vary': headers.vary = value; break;
      case 'content-type': headers['content-type'] = value; break;
      case 'content-length': headers['content-length'] = value; break;
      case 'server': headers.server = value; break;
      case 'x-cache': headers['x-cache'] = value; break;
      case 'cf-cache-status': headers['cf-cache-status'] = value; break;
    }

    if (key === ':status') {
      const parsedStatus = Number(value);
      if (Number.isInteger(parsedStatus)) statusCode = parsedStatus;
    }
  }

  const directStatus = readNumber(params['status_code'] ?? params['http_status_code']);
  if (directStatus !== null && directStatus >= 100 && directStatus <= 599) {
    statusCode = directStatus;
  }

  return { statusCode, headers };
}

type NetworkResourceType = CreateNetworkRequestInput['resourceType'];
type ResourceTypeSource = CreateNetworkRequestInput['resourceTypeSource'];

function resourceTypeFromContentType(contentType: string | undefined): NetworkResourceType | null {
  if (!contentType) return null;
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'document';
  if (mime === 'text/css') return 'stylesheet';
  if (/javascript|ecmascript|wasm/.test(mime)) return 'script';
  if (mime.startsWith('image/')) return 'image';
  if (/font|woff|opentype|ttf/.test(mime)) return 'font';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'media';
  if (/json|xml|graphql/.test(mime)) return 'fetch';
  return null;
}

function resourceTypeFromExtension(url: URL): NetworkResourceType | null {
  const pathname = url.pathname.toLowerCase();
  if (/\.(css)$/.test(pathname)) return 'stylesheet';
  if (/\.(m?js|cjs|wasm)$/.test(pathname)) return 'script';
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/.test(pathname)) return 'image';
  if (/\.(woff2?|ttf|otf|eot)$/.test(pathname)) return 'font';
  if (/\.(mp4|webm|mp3|wav|ogg|m4a)$/.test(pathname)) return 'media';
  if (/\.(html?|xhtml)$/.test(pathname)) return 'document';
  return null;
}

function eventTime(event: NetLogEvent): number | null {
  return readNumber(event.time);
}

function phaseName(phase: unknown, phaseNames: Map<number, string>): 'begin' | 'end' | 'none' {
  const numeric = readNumber(phase);
  if (numeric === null) {
    const value = String(phase ?? '').toLowerCase();
    if (value.includes('begin')) return 'begin';
    if (value.includes('end')) return 'end';
    return 'none';
  }
  const name = phaseNames.get(numeric)?.toLowerCase() ?? '';
  if (name.includes('begin')) return 'begin';
  if (name.includes('end')) return 'end';
  // NetLog's stable phase values: NONE=0, BEGIN=1, END=2.
  if (numeric === 1) return 'begin';
  if (numeric === 2) return 'end';
  return 'none';
}

function getDependencyId(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const id = readNumber(value['id']);
  return id !== null && Number.isInteger(id) ? id : null;
}

@Injectable()
export class NetLogParser {
  parse(
    input: Buffer,
    context: {
      captureStartedAt: Date;
      captureFinishedAt: Date;
      chromeVersion: string | null;
      targetHostname: string;
    },
  ): ParsedNetworkCapture {
    let dump: NetLogDump;
    try {
      dump = JSON.parse(input.toString('utf8')) as NetLogDump;
    } catch {
      throw new Error('NETLOG_INVALID_JSON');
    }

    if (!Array.isArray(dump.events) || !isRecord(dump.constants)) {
      throw new Error('NETLOG_UNSUPPORTED_FORMAT');
    }

    const constants = dump.constants;
    const eventTypeNames = reverseEnum(constants['logEventTypes']);
    const sourceTypeNames = reverseEnum(constants['logSourceType']);
    const phaseNames = reverseEnum(constants['logEventPhase']);
    const netErrorNames = reverseEnum(constants['netError']);

    const urlRequestSourceType = [...sourceTypeNames.entries()]
      .find(([, name]) => name === 'URL_REQUEST')?.[0];
    if (urlRequestSourceType === undefined) {
      throw new Error('NETLOG_UNSUPPORTED_FORMAT');
    }
    const events = dump.events.filter(isRecord) as NetLogEvent[];
    if (events.length === 0) throw new Error('NETLOG_NO_EVENTS');
    const firstEventTime = events.length > 0 ? eventTime(events[0] as NetLogEvent) : null;
    const groups = new Map<number, NetLogEvent[]>();

    for (const event of events) {
      const source = readRecord(event.source);
      const sourceId = readNumber(source['id']);
      if (sourceId === null || !Number.isInteger(sourceId)) continue;
      const group = groups.get(sourceId) ?? [];
      group.push(event);
      groups.set(sourceId, group);
    }

    const reverseEventTypes = new Map<number, string>(eventTypeNames);
    const allEventsBySource = groups;
    const requests: CreateNetworkRequestInput[] = [];
    let sequenceNumber = 0;

    for (const [sourceId, sourceEvents] of allEventsBySource) {
      const firstSource = readRecord(sourceEvents[0]?.source);
      if (readNumber(firstSource['type']) !== urlRequestSourceType) continue;

      const relatedSourceIds = new Set<number>([sourceId]);
      for (const [candidateId, candidateEvents] of allEventsBySource) {
        if (candidateId === sourceId) continue;
        const isDirectDependency = candidateEvents.some((event) => {
          const dependency = getDependencyId(readRecord(event.params)['source_dependency']);
          return dependency === sourceId;
        });
        if (isDirectDependency) relatedSourceIds.add(candidateId);
      }

      const relatedEvents = [...relatedSourceIds]
        .flatMap((id) => allEventsBySource.get(id) ?? [])
        .sort((left, right) => (eventTime(left) ?? 0) - (eventTime(right) ?? 0));

      const sourceSorted = [...sourceEvents].sort(
        (left, right) => (eventTime(left) ?? 0) - (eventTime(right) ?? 0),
      );
      const startJobId = [...reverseEventTypes.entries()]
        .find(([, name]) => name === 'URL_REQUEST_START_JOB')?.[0];

      const hops: RequestHop[] = [];
      const pending: RequestHop[] = [];

      if (startJobId !== undefined) {
        for (const event of sourceSorted) {
          if (readNumber(event.type) !== startJobId) continue;
          const phase = phaseName(event.phase, phaseNames);
          const params = readRecord(event.params);
          if (phase === 'begin') {
            const rawUrl = readString(params['url']);
            const method = (readString(params['method']) ?? 'UNKNOWN').toUpperCase().slice(0, 16);
            if (!rawUrl) continue;
            const hop: RequestHop = { begin: event, url: rawUrl, method };
            pending.push(hop);
            hops.push(hop);
          } else if (phase === 'end') {
            const openHop = pending.pop();
            if (openHop) openHop.end = event;
          }
        }
      }

      // Some Chrome builds expose the URL on a URL_REQUEST event even when the
      // START_JOB pair is absent. Keep one explicitly lower-confidence record.
      if (hops.length === 0) {
        const urlEvent = sourceSorted.find((event) => readString(readRecord(event.params)['url']));
        const rawUrl = readString(readRecord(urlEvent?.params)['url']);
        if (urlEvent && rawUrl) {
          const params = readRecord(urlEvent.params);
          hops.push({
            begin: urlEvent,
            url: rawUrl,
            method: (readString(params['method']) ?? 'UNKNOWN').toUpperCase().slice(0, 16),
          });
        }
      }

      for (let hopIndex = 0; hopIndex < hops.length; hopIndex += 1) {
        const hop = hops[hopIndex];
        if (!hop) continue;
        const safeUrl = sanitizeUrl(hop.url);
        if (!safeUrl) continue;

        const beginTime = eventTime(hop.begin);
        // If NetLog has no matching END event, leave completion/duration unknown.
        // Using the last event from the source can accidentally include unrelated work.
        const endTime = hop.end ? eventTime(hop.end) : null;
        const boundedEvents = relatedEvents.filter((event) => {
          const time = eventTime(event);
          return time !== null && (beginTime === null || time >= beginTime) && (endTime === null || time <= endTime);
        });

        let statusCode: number | null = null;
        let responseStartedAt: number | null = null;
        let failureCode: string | null = null;
        let protocol: string | null = null;
        let redirectLocation: string | null = null;
        let responseHeaders: SafeResponseHeaders = {};

        for (const event of boundedEvents) {
          const name = reverseEventTypes.get(readNumber(event.type) ?? -1) ?? '';
          const params = readRecord(event.params);
          if (name.includes('READ_RESPONSE_HEADERS') || name.includes('READ_TUNNEL_RESPONSE_HEADERS')) {
            const parsedHeaders = parseResponseHeaders(params);
            if (parsedHeaders.statusCode !== null) {
              statusCode = parsedHeaders.statusCode;
              responseStartedAt = eventTime(event);
              responseHeaders = parsedHeaders.headers;
            } else if (Object.keys(parsedHeaders.headers).length > 0) {
              responseHeaders = parsedHeaders.headers;
              responseStartedAt = eventTime(event);
            }
          }
          if (name === 'URL_REQUEST_REDIRECTED') {
            redirectLocation = readString(params['location']);
          }
          const candidateProtocol =
            readString(params['negotiated_protocol']) ??
            readString(params['protocol']) ??
            readString(params['connection_info']);
          if (candidateProtocol && !protocol) protocol = candidateProtocol.slice(0, 32);

          const netError = readNumber(params['net_error']);
          if (netError !== null && netError !== 0) {
            failureCode = netErrorNames.get(netError) ?? `NET_ERROR_${netError}`;
          }
        }

        if (!responseStartedAt && statusCode === null && hop.end) {
          const endParams = readRecord(hop.end.params);
          const netError = readNumber(endParams['net_error']);
          if (netError !== null && netError !== 0) {
            failureCode = netErrorNames.get(netError) ?? `NET_ERROR_${netError}`;
          }
        }

        const host = new URL(safeUrl).hostname.toLowerCase();
        const contentType = responseHeaders['content-type'];
        const contentTypeResource = resourceTypeFromContentType(contentType);
        const extensionResource = resourceTypeFromExtension(new URL(safeUrl));
        const resourceType = contentTypeResource ?? extensionResource ?? 'unknown';
        const resourceTypeSource: ResourceTypeSource = contentTypeResource
          ? 'content_type'
          : extensionResource
            ? 'url_extension'
            : 'unknown';
        const cacheControl = responseHeaders['cache-control'] ?? null;
        const cfCache = responseHeaders['cf-cache-status']?.toLowerCase();
        const xCache = responseHeaders['x-cache']?.toLowerCase() ?? '';
        let cacheStatus: 'hit' | 'miss' | 'revalidated' | 'bypass' | 'unknown' = 'unknown';
        if (cfCache === 'hit' || /\bhit\b/.test(xCache)) cacheStatus = 'hit';
        else if (cfCache === 'miss' || /\bmiss\b/.test(xCache)) cacheStatus = 'miss';
        else if (/revalidated|refresh_hit/.test(xCache)) cacheStatus = 'revalidated';
        else if (cacheControl && /no-store/i.test(cacheControl)) cacheStatus = 'bypass';

        const ageValue = responseHeaders.age ? Number(responseHeaders.age) : NaN;
        const startDate = beginTime === null
          ? null
          : new Date(context.captureStartedAt.getTime() + Math.max(0, beginTime - (firstEventTime ?? beginTime)));
        const responseDate = responseStartedAt === null
          ? null
          : new Date(context.captureStartedAt.getTime() + Math.max(0, responseStartedAt - (firstEventTime ?? responseStartedAt)));
        const endDate = endTime === null
          ? null
          : new Date(context.captureStartedAt.getTime() + Math.max(0, endTime - (firstEventTime ?? endTime)));
        const duration = beginTime !== null && endTime !== null
          ? Math.max(0, endTime - beginTime)
          : null;
        const availability: FieldAvailability = {
          url: 'available',
          method: hop.method === 'UNKNOWN' ? 'not_observed' : 'available',
          statusCode: statusCode === null ? 'not_observed' : 'available',
          protocol: protocol ? 'available' : 'not_observed',
          durationMs: duration === null ? 'not_observed' : 'available',
          transferredBytes: 'not_observed',
          encodedBodyBytes: 'not_observed',
          decodedBodyBytes: 'not_observed',
          dnsDurationMs: 'not_observed',
          connectDurationMs: 'not_observed',
          tlsDurationMs: 'not_observed',
          resourceType: resourceType === 'unknown' ? 'not_observed' : 'inferred',
          responseHeaders: Object.keys(responseHeaders).length > 0 ? 'available' : 'not_observed',
          initiator: 'not_observed',
        };

        sequenceNumber += 1;
        requests.push({
          sequenceNumber,
          netlogRequestId: String(sourceId).slice(0, 128),
          redirectChainKey: String(sourceId).slice(0, 128),
          url: safeUrl,
          urlHash: createHash('sha256').update(safeUrl).digest('hex'),
          hostname: host.slice(0, 253),
          method: hop.method || 'UNKNOWN',
          resourceType,
          resourceTypeSource,
          statusCode,
          protocol,
          isRedirect: Boolean(redirectLocation) || (statusCode !== null && statusCode >= 300 && statusCode < 400),
          isThirdParty: null,
          isFromServiceWorker: null,
          startedAt: startDate,
          responseStartedAt: responseDate,
          completedAt: endDate,
          durationMs: duration === null ? null : duration.toFixed(3),
          dnsDurationMs: null,
          connectDurationMs: null,
          tlsDurationMs: null,
          timeToFirstByteMs: null,
          downloadDurationMs: null,
          transferredBytes: null,
          encodedBodyBytes: null,
          decodedBodyBytes: null,
          cacheStatus,
          cacheControl,
          ageSeconds: Number.isInteger(ageValue) && ageValue >= 0 ? ageValue : null,
          etag: responseHeaders.etag ?? null,
          lastModified: responseHeaders['last-modified'] ?? null,
          contentEncoding: responseHeaders['content-encoding'] ?? null,
          responseHeaders,
          fieldAvailability: availability,
          failureCode: failureCode?.slice(0, 128) ?? null,
          failureMessage: null,
        });
      }
    }

    const chromeInfo = readRecord(constants['clientInfo']);
    const chromeVersion = context.chromeVersion ?? readString(chromeInfo['version']);
    const netlogVersion = readString(constants['version']) ?? readString(dump['netlog_version']);

    return {
      requests,
      eventCount: events.length,
      chromeVersion,
      netlogVersion,
      captureContext: {
        captureMode: 'Default',
        parserVersion: PARSER_VERSION,
        targetHostname: context.targetHostname,
        captureStartedAt: context.captureStartedAt.toISOString(),
        captureFinishedAt: context.captureFinishedAt.toISOString(),
        eventCount: events.length,
        sourceTypeUrlRequest: urlRequestSourceType,
        byteFieldsAvailable: false,
        timingUnit: 'milliseconds-as-serialized-by-NetLog',
        timestampMapping: 'capture-start plus offset from first observed event; approximate wall-clock mapping',
      },
    };
  }
}
