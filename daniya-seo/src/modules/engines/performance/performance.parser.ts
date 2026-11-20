import { Injectable } from '@nestjs/common';

export interface PerformanceTraceEvent {
  name: string;
  category?: string;
  phase?: string;
  timestamp?: number;
  duration?: number;
  threadId?: number;
  args?: Record<string, unknown>;
}

export interface PerformanceSnapshot {
  capturedAt: string;
  timeOrigin: number | null;

  cdpMetrics: Array<{
    name: string;
    value: number;
  }>;

  navigation: {
    type: string;
    nextHopProtocol: string;
    redirectCount: number;
    duration: number;
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
    transferSize: number;
    encodedBodySize: number;
    decodedBodySize: number;
  } | null;

  paint: Array<{
    name: string;
    startTime: number;
  }>;

  resources: {
    total: number;
    transferSizeBytes: number;
    encodedBodySizeBytes: number;
    decodedBodySizeBytes: number;
    topSlowest: Array<{
      name: string;
      initiatorType: string;
      duration: number;
      transferSize: number;
    }>;
  };

  observers: {
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
  };

  trace: {
    events: PerformanceTraceEvent[];
    droppedEvents: number;
  };
}

export interface PerformanceReport {
  meta: {
    capturedAt: string;
    timeOrigin: number | null;
    traceDroppedEvents: number;
  };

  navigation: {
    type: string | null;
    nextHopProtocol: string | null;
    redirectCount: number | null;
    totalDurationMs: number | null;
    dnsLookupMs: number | null;
    connectionMs: number | null;
    tlsHandshakeMs: number | null;
    requestMs: number | null;
    responseMs: number | null;
    domInteractiveMs: number | null;
    domContentLoadedMs: number | null;
    loadEventMs: number | null;
    transferSizeBytes: number | null;
    encodedBodySizeBytes: number | null;
    decodedBodySizeBytes: number | null;
  };

  paint: {
    firstPaintMs: number | null;
    firstContentfulPaintMs: number | null;
  };

  webVitals: {
    largestContentfulPaint: {
      startTimeMs: number;
      size: number;
      id: string;
      url: string;
      elementTagName: string | null;
      elementId: string | null;
    } | null;
    cumulativeLayoutShift: number;
    maxEventDurationMs: number | null;
    interactionCount: number;
  };

  resources: PerformanceSnapshot['resources'];

  longTasks: {
    count: number;
    totalDurationMs: number;
    maxDurationMs: number | null;
    entries: PerformanceSnapshot['observers']['longTasks'];
  };

  trace: {
    mainThreadTaskCount: number;
    longTaskCount: number;
    totalMainThreadTaskDurationMs: number;
    maxMainThreadTaskDurationMs: number | null;
    eventDurations: Record<string, number>;
  };

  runtime: {
    cdpMetrics: Record<string, number>;
  };
}

function difference(end: number, start: number): number | null {
  if (
    !Number.isFinite(end) ||
    !Number.isFinite(start) ||
    end <= 0 ||
    start <= 0 ||
    end < start
  ) {
    return null;
  }

  return end - start;
}

function calculateCls(
  entries: PerformanceSnapshot['observers']['layoutShifts'],
): number {
  const shifts = entries
    .filter((entry) => !entry.hadRecentInput)
    .sort((a, b) => a.startTime - b.startTime);

  let sessionStart = 0;
  let previousShiftTime = 0;
  let sessionValue = 0;
  let maxSessionValue = 0;

  for (const shift of shifts) {
    const newSession =
      sessionValue === 0 ||
      shift.startTime - previousShiftTime > 1000 ||
      shift.startTime - sessionStart > 5000;

    if (newSession) {
      sessionStart = shift.startTime;
      sessionValue = 0;
    }

    sessionValue += shift.value;
    previousShiftTime = shift.startTime;

    maxSessionValue = Math.max(maxSessionValue, sessionValue);
  }

  return maxSessionValue;
}

@Injectable()
export class PerformanceParser {
  parse(snapshot: PerformanceSnapshot): PerformanceReport {
    const navigation = snapshot.navigation;

    const getPaint = (name: string): number | null => {
      return (
        snapshot.paint.find((entry) => entry.name === name)?.startTime ??
        null
      );
    };

    const lcp = [...snapshot.observers.largestContentfulPaint].sort(
      (a, b) => b.startTime - a.startTime,
    )[0];

    const interactionDurations = new Map<number, number>();

    for (const event of snapshot.observers.eventTimings) {
      if (event.interactionId <= 0) continue;

      interactionDurations.set(
        event.interactionId,
        Math.max(
          interactionDurations.get(event.interactionId) ?? 0,
          event.duration,
        ),
      );
    }

    const eventDurations = [...interactionDurations.values()];

    const longTaskDurations = snapshot.observers.longTasks.map(
      (task) => task.duration,
    );

    const cdpMetrics = Object.fromEntries(
      snapshot.cdpMetrics.map((metric) => [
        metric.name,
        metric.value,
      ]),
    );

    const mainThreadEvents = snapshot.trace.events.filter(
      (event) =>
        event.phase === 'X' &&
        event.name === 'RunTask' &&
        event.duration !== undefined,
    );

    const mainThreadDurations = mainThreadEvents.map(
      (event) => (event.duration ?? 0) / 1000,
    );

    const traceEventDurations: Record<string, number> = {};

    for (const event of snapshot.trace.events) {
      if (event.phase !== 'X' || event.duration === undefined) {
        continue;
      }

      traceEventDurations[event.name] =
        (traceEventDurations[event.name] ?? 0) +
        event.duration / 1000;
    }

    return {
      meta: {
        capturedAt: snapshot.capturedAt,
        timeOrigin: snapshot.timeOrigin,
        traceDroppedEvents: snapshot.trace.droppedEvents,
      },

      navigation: {
        type: navigation?.type ?? null,
        nextHopProtocol: navigation?.nextHopProtocol ?? null,
        redirectCount: navigation?.redirectCount ?? null,
        totalDurationMs: navigation?.duration ?? null,

        dnsLookupMs: navigation
          ? difference(
              navigation.domainLookupEnd,
              navigation.domainLookupStart,
            )
          : null,

        connectionMs: navigation
          ? difference(navigation.connectEnd, navigation.connectStart)
          : null,

        tlsHandshakeMs:
          navigation && navigation.secureConnectionStart > 0
            ? difference(
                navigation.connectEnd,
                navigation.secureConnectionStart,
              )
            : null,

        requestMs: navigation
          ? difference(navigation.responseStart, navigation.requestStart)
          : null,

        responseMs: navigation
          ? difference(navigation.responseEnd, navigation.responseStart)
          : null,

        domInteractiveMs: navigation?.domInteractive ?? null,
        domContentLoadedMs:
          navigation?.domContentLoadedEventEnd ?? null,
        loadEventMs: navigation?.loadEventEnd ?? null,

        transferSizeBytes: navigation?.transferSize ?? null,
        encodedBodySizeBytes: navigation?.encodedBodySize ?? null,
        decodedBodySizeBytes: navigation?.decodedBodySize ?? null,
      },

      paint: {
        firstPaintMs: getPaint('first-paint'),
        firstContentfulPaintMs: getPaint('first-contentful-paint'),
      },

      webVitals: {
        largestContentfulPaint: lcp
          ? {
              startTimeMs: lcp.startTime,
              size: lcp.size,
              id: lcp.id,
              url: lcp.url,
              elementTagName: lcp.elementTagName,
              elementId: lcp.elementId,
            }
          : null,

        cumulativeLayoutShift: calculateCls(
          snapshot.observers.layoutShifts,
        ),

        maxEventDurationMs:
          eventDurations.length > 0
            ? Math.max(...eventDurations)
            : null,

        interactionCount: interactionDurations.size,
      },

      resources: snapshot.resources,

      longTasks: {
        count: longTaskDurations.length,

        totalDurationMs: longTaskDurations.reduce(
          (sum, duration) => sum + duration,
          0,
        ),

        maxDurationMs:
          longTaskDurations.length > 0
            ? Math.max(...longTaskDurations)
            : null,

        entries: snapshot.observers.longTasks,
      },

      trace: {
        mainThreadTaskCount: mainThreadEvents.length,

        longTaskCount: mainThreadDurations.filter(
          (duration) => duration >= 50,
        ).length,

        totalMainThreadTaskDurationMs:
          mainThreadDurations.reduce(
            (sum, duration) => sum + duration,
            0,
          ),

        maxMainThreadTaskDurationMs:
          mainThreadDurations.length > 0
            ? Math.max(...mainThreadDurations)
            : null,

        eventDurations: traceEventDurations,
      },

      runtime: {
        cdpMetrics,
      },
    };
  }
}