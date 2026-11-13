const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const TARGET_URL = process.argv[2] || 'https://tajhizyaragh.com/';
const CHROME_PATH =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WAIT_MS = 60_000;
const TOP_N = 30;
const OUTPUT_PATH = path.resolve('tmp', 'network-report.json');

const report = {
  meta: {
    targetUrl: TARGET_URL,
    startedAt: new Date().toISOString(),
    waitMs: WAIT_MS,
    navigationStartedAt: null,
    domContentLoadedMs: null,
    finishedAt: null,
    totalMs: null,
    errors: [],
  },
  sessions: [],
  targets: [],
  frames: [],
  cdp: { requests: [], failed: [], redirected: [], sortedIndices: [] },
  puppeteer: { requests: [], failed: [] },
  resourceTiming: { entries: [] },
  muChat: null,
};

let navigationStartedAt;
const attached = new WeakSet();

function elapsedMs() {
  return navigationStartedAt == null ? null : Date.now() - navigationStartedAt;
}

function parseContentLength(headers) {
  if (!headers) return null;
  const k = Object.keys(headers).find((n) => n.toLowerCase() === 'content-length');
  if (!k) return null;
  const v = Number(headers[k]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function fmt(bytes) {
  if (bytes == null) return '     null';
  if (bytes < 1024) return `${bytes} B`.padStart(9);
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`.padStart(9);
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`.padStart(9);
}

// ==== Attach to a target and collect Network on its own session ====
async function attachTarget(target) {
  const type = target.type();
  if (!['page', 'iframe', 'worker', 'service_worker', 'shared_worker'].includes(type)) {
    return;
  }
  if (attached.has(target)) return;
  attached.add(target);

  const targetUrl = target.url();
  let session;
  try {
    session = await target.createCDPSession();
  } catch (e) {
    report.meta.errors.push({ stage: 'attach', type, targetUrl, message: e.message });
    return;
  }

  try {
    await session.send('Network.enable');
  } catch (e) {
    report.meta.errors.push({ stage: 'network-enable', type, targetUrl, message: e.message });
    return;
  }

  const sessionIndex = report.sessions.length;
  const sessionInfo = {
    sessionIndex,
    targetType: type,
    targetUrl,
    attachedAtMs: elapsedMs(),
    requestCount: 0,
  };
  report.sessions.push(sessionInfo);

  const active = new Map();

  session.on('Network.requestWillBeSent', (e) => {
    const rec = {
      sessionIndex,
      targetType: type,
      targetUrl,
      requestId: e.requestId,
      url: e.request.url,
      method: e.request.method,
      resourceType: e.type || null,
      frameId: e.frameId || null,
      initiatorType: e.initiator?.type || null,
      initiatorUrl:
        e.initiator?.url ||
        e.initiator?.stack?.callFrames?.[0]?.url ||
        null,
      initiatorStack:
        e.initiator?.stack?.callFrames?.slice(0, 3).map((f) => ({
          url: f.url,
          fn: f.functionName,
          line: f.lineNumber,
        })) || null,
      elapsedMs: elapsedMs(),
      status: null,
      mimeType: null,
      contentLengthBytes: null,
      transferredBytes: null,
      receivedBytes: 0,
      encodedBytes: 0,
      fromCache: null,
      fromServiceWorker: null,
      failed: false,
      failureReason: null,
      finished: false,
      isRedirectFollowup: !!e.redirectResponse,
      redirected: false,
      redirectedTo: null,
      redirectStatus: null,
    };

    if (e.redirectResponse && active.has(e.requestId)) {
      const prev = active.get(e.requestId);
      prev.redirected = true;
      prev.redirectedTo = e.request.url;
      prev.redirectStatus = e.redirectResponse.status;
    }

    report.cdp.requests.push(rec);
    active.set(e.requestId, rec);
    sessionInfo.requestCount++;
  });

  session.on('Network.responseReceived', (e) => {
    const rec = active.get(e.requestId);
    if (!rec) return;
    rec.status = e.response.status;
    rec.mimeType = e.response.mimeType || null;
    rec.contentLengthBytes = parseContentLength(e.response.headers);
    rec.fromCache = e.response.fromDiskCache ?? null;
    rec.fromServiceWorker = e.response.fromServiceWorker ?? null;
  });

  session.on('Network.dataReceived', (e) => {
    const rec = active.get(e.requestId);
    if (!rec) return;
    rec.receivedBytes += e.dataLength || 0;
    rec.encodedBytes += e.encodedDataLength || 0;
  });

  session.on('Network.loadingFinished', (e) => {
    const rec = active.get(e.requestId);
    if (!rec) return;
    rec.transferredBytes = e.encodedDataLength;
    rec.finished = true;
    active.delete(e.requestId);
  });

  session.on('Network.loadingFailed', (e) => {
    const rec = active.get(e.requestId);
    if (!rec) return;
    rec.failed = true;
    rec.failureReason = e.errorText || 'Unknown';
    rec.canceled = e.canceled || false;
    active.delete(e.requestId);
  });
}

// ==== Puppeteer page listener (for comparison) ====
function setupPuppeteerListeners(page) {
  const map = new WeakMap();
  page.on('request', (req) => {
    const rec = {
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      elapsedMs: elapsedMs(),
      status: null,
      contentLengthBytes: null,
      failed: false,
      failureReason: null,
      finished: false,
    };
    map.set(req, rec);
    report.puppeteer.requests.push(rec);
  });
  page.on('response', (res) => {
    const rec = map.get(res.request());
    if (!rec) return;
    rec.status = res.status();
    rec.contentLengthBytes = parseContentLength(res.headers());
  });
  page.on('requestfinished', (req) => {
    const rec = map.get(req);
    if (rec) rec.finished = true;
  });
  page.on('requestfailed', (req) => {
    const rec = map.get(req);
    if (rec) {
      rec.failed = true;
      rec.failureReason = req.failure()?.errorText || 'Unknown';
    }
  });
}

// ==== Resource Timing from every frame ====
async function collectResourceTiming(page) {
  for (const frame of page.frames()) {
    const info = { url: frame.url(), name: frame.name(), parentUrl: null, error: null };
    try {
      info.parentUrl = frame.parentFrame()?.url() || null;
      const entries = await frame.evaluate(() =>
        performance.getEntriesByType('resource').map((e) => ({
          url: e.name,
          initiatorType: e.initiatorType,
          startTimeMs: Math.round(e.startTime),
          durationMs: Math.round(e.duration),
          transferSize: typeof e.transferSize === 'number' ? e.transferSize : null,
          encodedBodySize: typeof e.encodedBodySize === 'number' ? e.encodedBodySize : null,
          decodedBodySize: typeof e.decodedBodySize === 'number' ? e.decodedBodySize : null,
        })),
      );
      report.frames.push(info);
      for (const entry of entries) {
        report.resourceTiming.entries.push({ frameUrl: info.url, ...entry });
      }
    } catch (err) {
      info.error = err.message;
      report.frames.push(info);
    }
  }
}

// ==== Derive views: failed, redirected, sorted, mu.chat ====
function buildViews() {
  report.cdp.failed = report.cdp.requests.filter((r) => r.failed);
  report.cdp.redirected = report.cdp.requests.filter((r) => r.redirected);
  report.puppeteer.failed = report.puppeteer.requests.filter((r) => r.failed);

  const sortSize = (r) =>
    r.transferredBytes != null
      ? r.transferredBytes
      : r.contentLengthBytes != null
        ? r.contentLengthBytes
        : null;

  const sorted = [...report.cdp.requests].sort((a, b) => {
    const av = sortSize(a);
    const bv = sortSize(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });

  report.cdp.sortedIndices = sorted.map((r) => report.cdp.requests.indexOf(r));

  const isMu = (u) => /mu\.chat/i.test(u || '');
  report.muChat = {
    targets: report.targets.filter((t) => isMu(t.url)),
    sessions: report.sessions.filter((s) => isMu(s.targetUrl)),
    frames: report.frames.filter((f) => isMu(f.url)),
    cdpRequests: report.cdp.requests.filter((r) => isMu(r.url)),
    puppeteerRequests: report.puppeteer.requests.filter((r) => isMu(r.url)),
    frameResources: report.resourceTiming.entries.filter((r) => isMu(r.url)),
    sdkLoaded: report.cdp.requests.some((r) => /widget\.mu\.chat\/sdk\.js/i.test(r.url)),
    imageLoaded: report.cdp.requests.some((r) => /s3\.mu\.chat\/.*\.png/i.test(r.url)),
  };
}

// ==== Terminal output ====
function printSummary() {
  console.log('\n=== SUMMARY ===');
  console.log('Report:', OUTPUT_PATH);
  console.log('Duration:', report.meta.totalMs, 'ms');
  console.log('DCL:', report.meta.domContentLoadedMs, 'ms after navigation');

  console.log('\n=== COUNTS (per source, do NOT sum) ===');
  console.log('CDP total (all sessions/targets):', report.cdp.requests.length);
  console.log('  Failed:', report.cdp.failed.length);
  console.log('  Redirect responses:', report.cdp.redirected.length);
  console.log('Puppeteer (main page only):', report.puppeteer.requests.length);
  console.log('  Failed:', report.puppeteer.failed.length);
  console.log('Resource Timing entries (all frames):', report.resourceTiming.entries.length);

  console.log('\n=== SESSIONS ===');
  for (const s of report.sessions) {
    console.log(
      `  [${s.targetType}] ${s.requestCount} req  ${s.targetUrl || '(no url)'}`,
    );
  }

  console.log('\n=== TARGETS ===');
  for (const t of report.targets) {
    console.log(`  [${t.type}] ${t.url || '(no url)'}`);
  }

  console.log(`\n=== TOP ${TOP_N} BY TRANSFER SIZE (CDP, all targets) ===`);
  console.log('Rank   Transfer   Status  Type        URL');
  const sorted = report.cdp.sortedIndices.map((i) => report.cdp.requests[i]);
  for (let i = 0; i < Math.min(TOP_N, sorted.length); i++) {
    const r = sorted[i];
    const size = fmt(
      r.transferredBytes != null ? r.transferredBytes : r.contentLengthBytes,
    );
    const status = String(r.status ?? '?').padStart(3);
    const type = String(r.resourceType || r.targetType || '?').padEnd(10);
    const markers = [
      r.failed ? 'FAILED' : null,
      r.redirected ? 'REDIR' : null,
      r.isRedirectFollowup ? 'FOLLOWUP' : null,
      r.fromServiceWorker ? 'SW' : null,
      r.fromCache ? 'CACHE' : null,
    ]
      .filter(Boolean)
      .join(',');
    console.log(
      `${String(i + 1).padStart(4)}  ${size}  ${status}     ${type}  ${r.url}${
        markers ? ' [' + markers + ']' : ''
      }`,
    );
  }

  if (report.cdp.failed.length > 0) {
    console.log('\n=== FAILED REQUESTS (CDP) ===');
    for (const r of report.cdp.failed.slice(0, TOP_N)) {
      console.log(
        `  [${r.targetType}] ${r.method} ${r.url}`,
      );
      console.log(`    reason=${r.failureReason}, canceled=${r.canceled}`);
    }
  }

  if (report.cdp.redirected.length > 0) {
    console.log('\n=== REDIRECT RESPONSES (CDP) ===');
    for (const r of report.cdp.redirected.slice(0, TOP_N)) {
      console.log(
        `  ${r.redirectStatus} -> ${r.redirectedTo} (from ${r.url})`,
      );
    }
  }

  console.log('\n=== MU CHAT INVESTIGATION ===');
  console.log('SDK loaded:', report.muChat.sdkLoaded ? 'YES' : 'NO');
  console.log('Image loaded:', report.muChat.imageLoaded ? 'YES' : 'NO');
  console.log('Targets with mu.chat:', report.muChat.targets.length);
  console.log('Sessions with mu.chat:', report.muChat.sessions.length);
  console.log('Frames with mu.chat:', report.muChat.frames.length);
  console.log('CDP requests with mu.chat:', report.muChat.cdpRequests.length);
  console.log('Puppeteer requests with mu.chat:', report.muChat.puppeteerRequests.length);
  console.log('Frame resources with mu.chat:', report.muChat.frameResources.length);
  for (const r of report.muChat.cdpRequests.slice(0, 10)) {
    console.log(
      `  [${r.targetType}] ${r.status ?? '?'} ${r.resourceType ?? '?'} ` +
        `xfer=${r.transferredBytes} ${r.url}`,
    );
  }
}

// ==== Main ====
async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(`Chrome not found: ${CHROME_PATH}`);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--no-first-run'],
  });

  browser.on('targetcreated', (t) => {
    report.targets.push({ event: 'created', type: t.type(), url: t.url(), elapsedMs: elapsedMs() });
    attachTarget(t).catch(() => {});
  });
  browser.on('targetchanged', (t) => {
    report.targets.push({ event: 'changed', type: t.type(), url: t.url(), elapsedMs: elapsedMs() });
  });
  browser.on('targetdestroyed', (t) => {
    report.targets.push({ event: 'destroyed', type: t.type(), url: t.url(), elapsedMs: elapsedMs() });
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1365, height: 900 });
  setupPuppeteerListeners(page);

  // Attach to all existing targets BEFORE navigation
  for (const t of browser.targets()) {
    await attachTarget(t);
  }

  navigationStartedAt = Date.now();
  report.meta.navigationStartedAt = new Date(navigationStartedAt).toISOString();

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    report.meta.domContentLoadedMs = elapsedMs();
  } catch (err) {
    report.meta.errors.push({ stage: 'navigation', message: err.message, elapsedMs: elapsedMs() });
  }

  await new Promise((r) => setTimeout(r, WAIT_MS));

  await collectResourceTiming(page);

  report.meta.finishedAt = new Date().toISOString();
  report.meta.totalMs = elapsedMs();

  buildViews();

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2), 'utf8');
  printSummary();

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});