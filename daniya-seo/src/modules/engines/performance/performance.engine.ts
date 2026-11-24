import { Injectable } from '@nestjs/common';
import type { CDPSession, Page } from 'puppeteer-core';

import { PerformanceParser } from './performance.parser';
import type {
  PerformanceReport,
  PerformanceSnapshot,
  PerformanceTraceEvent,
} from './performance.parser';

interface BrowserObserverStore {
  longTasks: Array<{
    startTime: number;
    duration: number;
    name: string;
  }>;

  layoutShifts: Array<{
    startTime: number;
    value: number;
    hadRecentInput: boolean;
  }>;

  largestContentfulPaint: Array<{
    startTime: number;
    size: number;
    id: string;
    url: string;
    elementTagName: string | null;
    elementId: string | null;
  }>;

  eventTimings: Array<{
    startTime: number;
    duration: number;
    name: string;
    interactionId: number;
  }>;
}

interface BrowserPerformanceEntryLike {
  name: string;
  startTime: number;
  duration: number;
  initiatorType?: string;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  value?: number;
  hadRecentInput?: boolean;
  size?: number;
  id?: string;
  url?: string;
  interactionId?: number;
  element?: {
    tagName?: string;
    id?: string;
  };
}

interface BrowserNavigationEntryLike
  extends BrowserPerformanceEntryLike {
  type: string;
  nextHopProtocol: string;
  redirectCount: number;
  fetchStart: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  connectEnd: number;
  secureConnectionStart: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
  domInteractive: number;
  domContentLoadedEventEnd: number;
  loadEventEnd: number;
}

interface BrowserPerformanceApi {
  timeOrigin: number;
  getEntriesByType(
    type: string,
  ): BrowserPerformanceEntryLike[];
}

interface BrowserObserverList {
  getEntries(): BrowserPerformanceEntryLike[];
}

interface BrowserObserver {
  observe(options: {
    type: string;
    buffered?: boolean;
    durationThreshold?: number;
  }): void;
}

interface BrowserObserverConstructor {
  new (callback: (list: BrowserObserverList) => void): BrowserObserver;
  supportedEntryTypes?: string[];
}

interface BrowserGlobal {
  PerformanceObserver?: BrowserObserverConstructor;
  performance: BrowserPerformanceApi;
  __daniyaPerformance?: BrowserObserverStore;
}

interface TraceEventBatch {
  value: unknown[];
}

export interface PerformanceCapture {
  page: Page;
  client: CDPSession;
  events: PerformanceTraceEvent[];
  droppedEvents: number;
  onDataCollected: (event: TraceEventBatch) => void;
}

const MAX_TRACE_EVENTS = 20_000;
const TRACING_TIMEOUT_MS = 30_000;

const TRACE_EVENT_NAMES = new Set([
  'thread_name',
  'RunTask',
  'FunctionCall',
  'EvaluateScript',
  'CompileScript',
  'ParseHTML',
  'Layout',
  'Paint',
  'UpdateLayoutTree',
  'RecalculateStyles',
  'CompositeLayers',
  'UpdateLayerTree',
  'RasterTask',
]);

@Injectable()
export class PerformanceEngine {
  constructor(private readonly parser: PerformanceParser) {}

  async start(page: Page): Promise<PerformanceCapture> {
    const client = await page.createCDPSession();

    const events: PerformanceTraceEvent[] = [];
    const counters = {
      droppedEvents: 0,
    };

    let onDataCollected:
      | ((event: TraceEventBatch) => void)
      | undefined;

    let tracingStarted = false;

    try {
      await client.send('Performance.enable');

      await page.evaluateOnNewDocument(() => {
        const browser = globalThis as unknown as BrowserGlobal;

        const store: BrowserObserverStore = {
          longTasks: [],
          layoutShifts: [],
          largestContentfulPaint: [],
          eventTimings: [],
        };

        Object.defineProperty(browser, '__daniyaPerformance', {
          value: store,
          writable: false,
          configurable: false,
        });

        const Observer = browser.PerformanceObserver;
        const supported = Observer?.supportedEntryTypes ?? [];

        if (!Observer) return;

        const observe = (
          type: string,
          callback: (entry: BrowserPerformanceEntryLike) => void,
          durationThreshold?: number,
        ) => {
          if (!supported.includes(type)) return;

          try {
            const observer = new Observer((list) => {
              for (const entry of list.getEntries()) {
                callback(entry);
              }
            });

            observer.observe({
              type,
              buffered: true,
              ...(durationThreshold !== undefined
                ? { durationThreshold }
                : {}),
            });
          } catch {
            return;
          }
        };

        observe('longtask', (entry) => {
          store.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
            name: entry.name,
          });
        });

        observe('layout-shift', (entry) => {
          store.layoutShifts.push({
            startTime: entry.startTime,
            value: entry.value ?? 0,
            hadRecentInput: entry.hadRecentInput ?? false,
          });
        });

        observe('largest-contentful-paint', (entry) => {
          store.largestContentfulPaint.push({
            startTime: entry.startTime,
            size: entry.size ?? 0,
            id: entry.id ?? '',
            url: entry.url ?? '',
            elementTagName: entry.element?.tagName ?? null,
            elementId: entry.element?.id ?? null,
          });
        });

        observe(
          'event',
          (entry) => {
            store.eventTimings.push({
              startTime: entry.startTime,
              duration: entry.duration,
              name: entry.name,
              interactionId: entry.interactionId ?? 0,
            });
          },
          16,
        );
      });

      onDataCollected = (event: TraceEventBatch) => {
        for (const item of event.value) {
          if (!item || typeof item !== 'object') continue;

          const raw = item as Record<string, unknown>;
          const name =
            typeof raw['name'] === 'string'
              ? raw['name']
              : '';

          if (!TRACE_EVENT_NAMES.has(name)) continue;

          if (events.length >= MAX_TRACE_EVENTS) {
            counters.droppedEvents++;
            continue;
          }

          events.push({
            name,
            category:
              typeof raw['cat'] === 'string'
                ? raw['cat']
                : undefined,
            phase:
              typeof raw['ph'] === 'string'
                ? raw['ph']
                : undefined,
            timestamp:
              typeof raw['ts'] === 'number'
                ? raw['ts']
                : undefined,
            duration:
              typeof raw['dur'] === 'number'
                ? raw['dur']
                : undefined,
            threadId:
              typeof raw['tid'] === 'number'
                ? raw['tid']
                : undefined,
            args:
              raw['args'] && typeof raw['args'] === 'object'
                ? (raw['args'] as Record<string, unknown>)
                : undefined,
          });
        }
      };

      client.on('Tracing.dataCollected', onDataCollected);

      await client.send('Tracing.start', {
        categories: [
          'devtools.timeline',
          'v8.execute',
          'blink.user_timing',
          'loading',
          'toplevel',
        ].join(','),
        transferMode: 'ReportEvents',
      });

      tracingStarted = true;

      return {
        page,
        client,
        events,
        get droppedEvents() {
          return counters.droppedEvents;
        },
        onDataCollected,
      };
    } catch (error: unknown) {
      if (tracingStarted) {
        await this.stopTracing(client).catch(() => undefined);
      }

      if (onDataCollected) {
        client.off('Tracing.dataCollected', onDataCollected);
      }

      if (!client.detached) {
        await client.detach().catch(() => undefined);
      }

      throw error;
    }
  }

  async stop(
    capture: PerformanceCapture,
  ): Promise<PerformanceReport> {
    try {
      await this.stopTracing(capture.client);

      const [{ metrics }, browserData] = await Promise.all([
        capture.client.send('Performance.getMetrics'),

        capture.page.evaluate(() => {
          const browser = globalThis as unknown as BrowserGlobal;
          const performance = browser.performance;

          const navigationEntry = performance.getEntriesByType(
            'navigation',
          )[0] as BrowserNavigationEntryLike | undefined;

          const paintEntries = performance
            .getEntriesByType('paint')
            .map((entry) => ({
              name: entry.name,
              startTime: entry.startTime,
            }));

          const resourceEntries = performance
            .getEntriesByType('resource')
            .map((resource) => ({
              name: resource.name,
              initiatorType: resource.initiatorType ?? '',
              duration: resource.duration,
              transferSize: resource.transferSize ?? 0,
              encodedBodySize: resource.encodedBodySize ?? 0,
              decodedBodySize: resource.decodedBodySize ?? 0,
            }));

          const observers = browser.__daniyaPerformance ?? {
            longTasks: [],
            layoutShifts: [],
            largestContentfulPaint: [],
            eventTimings: [],
          };

          const total = resourceEntries.reduce(
            (result, resource) => ({
              transferSizeBytes:
                result.transferSizeBytes + resource.transferSize,
              encodedBodySizeBytes:
                result.encodedBodySizeBytes +
                resource.encodedBodySize,
              decodedBodySizeBytes:
                result.decodedBodySizeBytes +
                resource.decodedBodySize,
            }),
            {
              transferSizeBytes: 0,
              encodedBodySizeBytes: 0,
              decodedBodySizeBytes: 0,
            },
          );

          const topSlowest = [...resourceEntries]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 20)
            .map((resource) => ({
              name: resource.name,
              initiatorType: resource.initiatorType,
              duration: resource.duration,
              transferSize: resource.transferSize,
            }));

          return {
            timeOrigin: performance.timeOrigin,

            navigation: navigationEntry
              ? {
                  type: navigationEntry.type,
                  nextHopProtocol: navigationEntry.nextHopProtocol,
                  redirectCount: navigationEntry.redirectCount,
                  duration: navigationEntry.duration,
                  fetchStart: navigationEntry.fetchStart,
                  domainLookupStart:
                    navigationEntry.domainLookupStart,
                  domainLookupEnd: navigationEntry.domainLookupEnd,
                  connectStart: navigationEntry.connectStart,
                  connectEnd: navigationEntry.connectEnd,
                  secureConnectionStart:
                    navigationEntry.secureConnectionStart,
                  requestStart: navigationEntry.requestStart,
                  responseStart: navigationEntry.responseStart,
                  responseEnd: navigationEntry.responseEnd,
                  domInteractive: navigationEntry.domInteractive,
                  domContentLoadedEventEnd:
                    navigationEntry.domContentLoadedEventEnd,
                  loadEventEnd: navigationEntry.loadEventEnd,
                  transferSize:
                    navigationEntry.transferSize ?? 0,
                  encodedBodySize:
                    navigationEntry.encodedBodySize ?? 0,
                  decodedBodySize:
                    navigationEntry.decodedBodySize ?? 0,
                }
              : null,

            paint: paintEntries,

            resources: {
              total: resourceEntries.length,
              ...total,
              topSlowest,
            },

            observers,
          };
        }),
      ]);

      const snapshot: PerformanceSnapshot = {
        ...browserData,
        capturedAt: new Date().toISOString(),
        cdpMetrics: metrics.map((metric) => ({
          name: metric.name,
          value: metric.value,
        })),
        trace: {
          events: capture.events,
          droppedEvents: capture.droppedEvents,
        },
      };

      return this.parser.parse(snapshot);
    } finally {
      capture.client.off(
        'Tracing.dataCollected',
        capture.onDataCollected,
      );

      if (!capture.client.detached) {
        await capture.client.detach().catch(() => undefined);
      }
    }
  }

  private async stopTracing(client: CDPSession): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.off('Tracing.tracingComplete', onComplete);
        reject(new Error('Chrome tracing timed out.'));
      }, TRACING_TIMEOUT_MS);

      const onComplete = () => {
        clearTimeout(timeout);
        resolve();
      };

      client.once('Tracing.tracingComplete', onComplete);

      client.send('Tracing.end').catch((error: unknown) => {
        clearTimeout(timeout);
        client.off('Tracing.tracingComplete', onComplete);
        reject(error);
      });
    });
  }
}