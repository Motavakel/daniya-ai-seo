'use strict';

// node .\scripts\network-audit.cjs https://tajhizyaragh.com/

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');


const TARGET_URL = process.argv[2];
const CHROME_PATH =
  process.env.CHROME_PATH ||
  (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome');

const WAIT_SECONDS = Number(process.env.WAIT_SECONDS || 60);
const WAIT_MS = WAIT_SECONDS * 1000;
const NAVIGATION_TIMEOUT_MS = 90_000;
const NETLOG_DURATION_SECONDS =
  Math.ceil((NAVIGATION_TIMEOUT_MS + WAIT_MS) / 1000) + 30;
const NETLOG_MAX_SIZE_MB = Number(
  process.env.NETLOG_MAX_SIZE_MB || 200,
);

const TOP_N = 30;
const OUTPUT_DIR = path.resolve(
  process.env.REPORT_DIR || 'tmp',
);
const NETLOG_PATH = path.join(
  OUTPUT_DIR,
  'chrome-netlog.json',
);
const JSON_PATH = path.join(
  OUTPUT_DIR,
  'network-report.json',
);
const CSV_PATH = path.join(
  OUTPUT_DIR,
  'network-report.csv',
);

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) {
    return 'Unknown';
  }

  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

// ==================================================
// NetLog header parsing
// ==================================================

function headerLines(headers) {
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
        return [`${item.name || ''}: ${item.value || ''}`];
      }

      return [];
    });
  }

  if (typeof headers === 'object') {
    if (Array.isArray(headers.headers)) {
      return headerLines(headers.headers);
    }

    return Object.entries(headers).map(
      ([key, value]) => `${key}: ${value}`,
    );
  }

  return [];
}

function readHeaders(record, headers, kind) {
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

// ==================================================
// Resource type detection
// ==================================================

function inferResourceType(record) {
  const dest = String(
    record.fetchDestination || '',
  ).toLowerCase();

  const requestType = String(
    record.requestType || '',
  ).toLowerCase();

  const mime = String(
    record.mimeType || '',
  ).toLowerCase();

  const url = String(record.url || '')
    .toLowerCase()
    .split(/[?#]/)[0];

  const destinations = {
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

  const extensions = {
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

  return record.fetchMode === 'cors'
    ? 'fetch/xhr'
    : 'other';
}

// ==================================================
// NetLog Parser
// ==================================================

function parseNetLog(netlog) {
  if (!Array.isArray(netlog.events)) {
    throw new Error('NetLog events array is missing.');
  }

  const eventTypes = netlog.constants?.logEventTypes;

  if (!eventTypes) {
    throw new Error('NetLog event type constants are missing.');
  }

  // Event IDs are resolved dynamically.
  // No hardcoded numeric event IDs.

  const eventNames = new Map(
    Object.entries(eventTypes).map(([name, id]) => [
      Number(id),
      name,
    ]),
  );

  const nameOf = (event) =>
    eventNames.get(Number(event.type));

  // Find all actual URL_REQUEST sources.
  const requestSourceIds = new Set();

  for (const event of netlog.events) {
    if (
      nameOf(event) === 'URL_REQUEST_START_JOB' &&
      event.source?.id != null
    ) {
      requestSourceIds.add(String(event.source.id));
    }
  }

  const records = new Map();

  const eventCounts = {
    URL_REQUEST_START_JOB: 0,
    URL_REQUEST_REDIRECTED: 0,
    URL_REQUEST_JOB_BYTES_READ: 0,
    URL_REQUEST_JOB_FILTERED_BYTES_READ: 0,
    requestHeaderEvents: 0,
    responseHeaderEvents: 0,
  };

  let firstRequestTick = null;

  function getRecord(source) {
    const id = String(source.id);

    if (!records.has(id)) {
      records.set(id, {
        sourceId: id,

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

        // Separate byte counters.
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
      });
    }

    return records.get(id);
  }

  function appendUrl(record, url) {
    if (typeof url !== 'string' || !url) return;

    if (record.urlHistory.at(-1) !== url) {
      record.urlHistory.push(url);
    }

    if (!record.initialUrl) {
      record.initialUrl = url;
    }

    record.url = url;
  }

  for (const event of netlog.events) {
    if (
      event.source?.id == null ||
      !requestSourceIds.has(String(event.source.id))
    ) {
      continue;
    }

    const eventName = nameOf(event);

    if (!eventName) continue;

    const params = event.params || {};
    const record = getRecord(event.source);

    const tick = numberOrNull(event.time);

    if (tick !== null) {
      if (
        record.startTick === null ||
        tick < record.startTick
      ) {
        record.startTick = tick;
      }

      if (
        record.endTick === null ||
        tick > record.endTick
      ) {
        record.endTick = tick;
      }

      if (
        firstRequestTick === null ||
        tick < firstRequestTick
      ) {
        firstRequestTick = tick;
      }
    }

    switch (eventName) {
      case 'URL_REQUEST_START_JOB': {
        eventCounts.URL_REQUEST_START_JOB++;

        appendUrl(record, params.url);

        if (params.method) record.method = params.method;
        if (params.request_type) record.requestType = params.request_type;
        if (params.initiator) record.initiator = params.initiator;

        if (
          params.net_error != null &&
          Number(params.net_error) !== 0
        ) {
          record.failed = true;
          record.netError = params.net_error;
        }

        break;
      }

      case 'URL_REQUEST_REDIRECTED': {
        eventCounts.URL_REQUEST_REDIRECTED++;

        if (params.location) {
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
          record.netError = params.net_error;
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
          record.netError = params.net_error;
        }
      }
    }
  }

  const requests = [...records.values()].map((record) => {
    // Never add pre-filter and post-filter bytes together.
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
      record.startTick !== null &&
      record.endTick !== null
        ? Math.max(0, record.endTick - record.startTick)
        : null;

    record.redirectCount = record.redirects.length;

    record.offsetFromFirstRequestMs =
      record.startTick !== null &&
      firstRequestTick !== null
        ? Math.max(0, record.startTick - firstRequestTick)
        : null;

    return record;
  });

  return {
    requests,
    eventCounts,
    eventCount: netlog.events.length,
  };
}

// ==================================================
// Report generation
// ==================================================

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function analyzeAndSave(netlogPath, navigationWarning = null) {
  const netlog = JSON.parse(
    fs.readFileSync(netlogPath, 'utf8'),
  );

  const parsed = parseNetLog(netlog);

  const sorted = parsed.requests.sort(
    (a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1),
  );

  const withSize = sorted.filter(
    (record) => record.sizeBytes !== null,
  );

  const top = withSize.slice(0, TOP_N);

  const measured = sorted.filter(
    (record) => record.sizeSource.startsWith('netlog-'),
  );

  const fallback = sorted.filter(
    (record) => record.sizeSource === 'content-length-fallback',
  );

  const measuredBytes = measured.reduce(
    (sum, record) => sum + record.sizeBytes,
    0,
  );

  const fallbackBytes = fallback.reduce(
    (sum, record) => sum + record.sizeBytes,
    0,
  );

  const result = {
    meta: {
      targetUrl: TARGET_URL,
      analyzedAt: new Date().toISOString(),
      rawNetlogPath: netlogPath,
      rawNetlogBytes: fs.statSync(netlogPath).size,
      rawEventCount: parsed.eventCount,
      observationSeconds: WAIT_SECONDS,
      navigationWarning,
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

    eventCounts: parsed.eventCounts,
    requests: sorted,
    topRequests: top,
  };

  fs.writeFileSync(
    JSON_PATH,
    JSON.stringify(result, null, 2),
    'utf8',
  );

  const columns = [
    'rank',
    'url',
    'method',
    'resourceType',
    'status',
    'sizeBytes',
    'sizeSource',
    'preFilterBodyBytes',
    'postFilterBodyBytes',
    'contentLengthBytes',
    'mimeType',
    'redirectCount',
    'failed',
    'netError',
    'sourceId',
  ];

  const csv = [
    columns.join(','),

    ...sorted.map((record, index) => {
      const row = { rank: index + 1, ...record };

      return columns
        .map((column) => csvEscape(row[column]))
        .join(',');
    }),
  ];

  fs.writeFileSync(
    CSV_PATH,
    '\uFEFF' + csv.join('\r\n'),
    'utf8',
  );

  // Terminal report
  console.log('\n=== NETWORK AUDIT SUMMARY ===');

  console.log('Target:', TARGET_URL);
  console.log('NetLog events:', parsed.eventCount);
  console.log('Requests:', result.summary.totalRequests);
  console.log('Requests with size:', result.summary.requestsWithSize);
  console.log('Requests without size:', result.summary.requestsWithoutSize);
  console.log('Failed:', result.summary.failedRequests);
  console.log('Redirected:', result.summary.redirectedRequests);
  console.log('Measured response body:', result.summary.measuredBodySize);
  console.log('Content-Length fallback:', result.summary.fallbackSize);

  if (
    parsed.eventCounts.URL_REQUEST_JOB_BYTES_READ === 0 &&
    parsed.eventCounts.URL_REQUEST_JOB_FILTERED_BYTES_READ === 0
  ) {
    console.log(
      '\nWARNING: No NetLog byte-read events found. ' +
      'Sizes may rely on Content-Length only.',
    );
  }

  console.log(`\n=== TOP ${top.length} REQUESTS BY BODY SIZE ===`);

  console.table(
    top.map((record, index) => ({
      rank: index + 1,
      size: formatBytes(record.sizeBytes),
      status: record.status ?? '?',
      type: record.resourceType,
      method: record.method || '?',
      sizeSource: record.sizeSource,
      url: record.url,
    })),
  );

  console.log('\n=== OUTPUT FILES ===');
  console.log('Raw NetLog:', netlogPath);
  console.log('JSON:', JSON_PATH);
  console.log('CSV:', CSV_PATH);
}

// ==================================================
// Chrome capture
// ==================================================

async function main() {
  if (!TARGET_URL) {
    throw new Error(
      'Usage: node scripts/network-audit.cjs https://example.com',
    );
  }

  let url;

  try {
    url = new URL(TARGET_URL);
  } catch {
    throw new Error(`Invalid URL: ${TARGET_URL}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported.');
  }

  if (!Number.isFinite(WAIT_SECONDS) || WAIT_SECONDS <= 0) {
    throw new Error('WAIT_SECONDS must be positive.');
  }

  if (!Number.isFinite(NETLOG_MAX_SIZE_MB) || NETLOG_MAX_SIZE_MB <= 0) {
    throw new Error('NETLOG_MAX_SIZE_MB must be positive.');
  }

  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(
      `Chrome not found: ${CHROME_PATH}. Set CHROME_PATH.`,
    );
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const file of [NETLOG_PATH, JSON_PATH, CSV_PATH]) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }

  let browser;
  let navigationWarning = null;

  try {
    console.log('\n=== CHROME NETLOG NETWORK AUDIT ===');

    console.log('Target:', TARGET_URL);
    console.log('Observation window:', `${WAIT_SECONDS} seconds`);
    console.log('Starting Chrome...');

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: process.env.HEADLESS === 'true',

      args: [
        '--no-first-run',
        `--log-net-log=${NETLOG_PATH}`,
        '--net-log-capture-mode=Default',
        `--net-log-duration=${NETLOG_DURATION_SECONDS}`,
        `--net-log-max-size-mb=${NETLOG_MAX_SIZE_MB}`,
      ],
    });

    const pages = await browser.pages();

    const page = pages[0] || await browser.newPage();

    await page.setViewport({
      width: 1365,
      height: 900,
    });

    console.log('Navigating...');

    try {
      await page.goto(TARGET_URL, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });

      console.log('DOMContentLoaded reached.');
    } catch (error) {
      navigationWarning = error.message;
      console.error('Navigation warning:', error.message);
    }

    // Fixed 60-second window after DOMContentLoaded.
    console.log(
      `\nCapturing network activity for ${WAIT_SECONDS} seconds...`,
    );

    const startedAt = Date.now();
    let lastPrinted = 0;

    while (Date.now() - startedAt < WAIT_MS) {
      const elapsed = Date.now() - startedAt;

      await sleep(
        Math.min(1000, WAIT_MS - elapsed),
      );

      const seconds = Math.floor(
        (Date.now() - startedAt) / 1000,
      );

      if (
        seconds > 0 &&
        seconds % 10 === 0 &&
        seconds !== lastPrinted
      ) {
        console.log(`Captured ${seconds}/${WAIT_SECONDS}s`);
        lastPrinted = seconds;
      }
    }

    console.log('\nObservation window completed.');
  } finally {
    if (browser) {
      console.log('Closing Chrome and flushing NetLog...');

      await browser.close().catch((error) => {
        console.error('Chrome close warning:', error.message);
      });
    }
  }

  if (!fs.existsSync(NETLOG_PATH)) {
    throw new Error(`NetLog was not created: ${NETLOG_PATH}`);
  }

  if (fs.statSync(NETLOG_PATH).size === 0) {
    throw new Error('NetLog file is empty.');
  }

  console.log(
    'NetLog file:',
    formatBytes(fs.statSync(NETLOG_PATH).size),
  );

  console.log('Analyzing requests...');

  analyzeAndSave(NETLOG_PATH, navigationWarning);
}

main().catch((error) => {
  console.error('\n[NETWORK AUDIT FAILED]', error.message);

  if (process.env.DEBUG) {
    console.error(error.stack);
  }

  process.exitCode = 1;
});
