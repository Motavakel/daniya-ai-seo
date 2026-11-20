import { Injectable } from '@nestjs/common';
import type { CDPSession, Page } from 'puppeteer-core';

import {
  PerformanceParser,
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
    let droppedEvents = 0;

    try {
      await client.send('Performance.enable');

      await page.evaluateOnNewDocument(() => {
        const store: BrowserObserverStore = {
          longTasks: [],
          layoutShifts: [],
          largestContentfulPaint: [],
          eventTimings: [],
        };

        Object.defineProperty(window, '__daniyaPerformance', {
          value: store,
          writable: false,
          configurable: false,
        });

        const supported = PerformanceObserver.supportedEntryTypes;

        const observe = (
          type: string,
          callback: (entry: PerformanceEntry) => void,
          durationThreshold?: number,
        ) => {
          if (!supported.includes(type)) return;

          try {
            const observer = new PerformanceObserver((list) => {
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
            } as unknown as PerformanceObserverInit);
          } catch {
            // Unsupported observer types are ignored.
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
          const shift = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          };

          store.layoutShifts.push({
            startTime: shift.startTime,
            value: shift.value,
            hadRecentInput: shift.hadRecentInput,
          });
        });

        observe('largest-contentful-paint', (entry) => {
          const lcp = entry as PerformanceEntry & {
            size: number;
            id: string;
            url: string;
            element?: Element;
          };

          store.largestContentfulPaint.push({
            startTime: lcp.startTime,
            size: lcp.size,
            id: lcp.id ?? '',
            url: lcp.url ?? '',
            elementTagName: lcp.element?.tagName ?? null,
            elementId: lcp.element?.id ?? null,
          });
        });

        observe(
          'event',
          (entry) => {
            const event = entry as PerformanceEntry & {
              interactionId?: number;
            };

            store.eventTimings.push({
              startTime: event.startTime,
              duration: event.duration,
              name: event.name,
              interactionId: event.interactionId ?? 0,
            });
          },
          16,
        );
      });

      const onDataCollected = (event: TraceEventBatch) => {
        for (const item of event.value) {
          if (!item || typeof item !== 'object') continue;

          const raw = item as Record<string, unknown>;
          const name = String(raw.name ?? '');

          if (!TRACE_EVENT_NAMES.has(name)) continue;

          if (events.length >= MAX_TRACE_EVENTS) {
            droppedEvents++;
            continue;
          }

          events.push({
            name,
            category:
              typeof raw.cat === 'string' ? raw.cat : undefined,
            phase:
              typeof raw.ph === 'string' ? raw.ph : undefined,
            timestamp:
              typeof raw.ts === 'number' ? raw.ts : undefined,
            duration:
              typeof raw.dur === 'number' ? raw.dur : undefined,
            threadId:
              typeof raw.tid === 'number' ? raw.tid : undefined,
            args:
              raw.args && typeof raw.args === 'object'
                ? (raw.args as Record<string, unknown>)
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

      return {
        page,
        client,
        events,
        droppedEvents,
        onDataCollected,
      };
    } catch (error: unknown) {
      client.off('Tracing.dataCollected', () => undefined);

      await client.detach().catch(() => undefined);

      throw error;
    }
  }

  async stop(capture: PerformanceCapture): Promise<PerformanceReport> {
    try {
      await this.stopTracing(capture.client);

      const [{ metrics }, browserData] = await Promise.all([
        capture.client.send('Performance.getMetrics'),

        capture.page.evaluate(() => {
          const navigationEntry = performance.getEntriesByType(
            'navigation',
          )[0] as PerformanceNavigationTiming | undefined;

          const paintEntries = performance
            .getEntriesByType('paint')
            .map((entry) => ({
              name: entry.name,
              startTime: entry.startTime,
            }));

          const resourceEntries = performance
            .getEntriesByType('resource')
            .map((entry) => {
              const resource = entry as PerformanceResourceTiming;

              return {
                name: resource.name,
                initiatorType: resource.initiatorType,
                duration: resource.duration,
                transferSize: resource.transferSize,
                encodedBodySize: resource.encodedBodySize,
                decodedBodySize: resource.decodedBodySize,
              };
            });

          const observerStore = (
            window as Window & {
              __daniyaPerformance?: BrowserObserverStore;
            }
          ).__daniyaPerformance;

          const observers = observerStore ?? {
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
                result.encodedBodySizeBytes + resource.encodedBodySize,
              decodedBodySizeBytes:
                result.decodedBodySizeBytes + resource.decodedBodySize,
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
                  domainLookupStart: navigationEntry.domainLookupStart,
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
                  transferSize: navigationEntry.transferSize,
                  encodedBodySize: navigationEntry.encodedBodySize,
                  decodedBodySize: navigationEntry.decodedBodySize,
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
      }, 30_000);

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