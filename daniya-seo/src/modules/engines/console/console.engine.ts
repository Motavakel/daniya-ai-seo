import { Injectable } from '@nestjs/common';
import type { ConsoleMessage, Page } from 'puppeteer-core';

import {
  ConsoleParser,
  type ConsoleRecord,
  type ConsoleReport,
} from './console.parser';

export interface ConsoleCapture {
  page: Page;
  records: ConsoleRecord[];
  onConsole: (message: ConsoleMessage) => void;
  onPageError: (error: unknown) => void;
}

@Injectable()
export class ConsoleEngine {
  constructor(private readonly parser: ConsoleParser) {}

  start(page: Page): ConsoleCapture {
    const records: ConsoleRecord[] = [];

    const onConsole = (message: ConsoleMessage) => {
      const location = message.location();

      records.push({
        source: 'console',
        type: message.type(),
        text: message.text(),
        timestamp: new Date().toISOString(),
        url: location.url || null,
        lineNumber: location.lineNumber ?? null,
        columnNumber: location.columnNumber ?? null,
        stack: null,
      });
    };

    const onPageError = (error: unknown) => {
      records.push({
        source: 'pageerror',
        type: 'error',
        text: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
        url: null,
        lineNumber: null,
        columnNumber: null,
        stack: error instanceof Error ? error.stack ?? null : null,
      });
    };

    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    return {
      page,
      records,
      onConsole,
      onPageError,
    };
  }

  stop(capture: ConsoleCapture): ConsoleReport {
    capture.page.off('console', capture.onConsole);
    capture.page.off('pageerror', capture.onPageError);

    return this.parser.parse(capture.records);
  }
}