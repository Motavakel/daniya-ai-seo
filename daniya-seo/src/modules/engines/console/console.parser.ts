import { Injectable } from '@nestjs/common';

export interface ConsoleRecord {
  source: 'console' | 'pageerror';
  type: string;
  text: string;
  timestamp: string;
  url: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  stack: string | null;
}

export interface ConsoleReport {
  summary: {
    totalMessages: number;
    errors: number;
    warnings: number;
    pageErrors: number;
    messagesByType: Record<string, number>;
  };
  messages: ConsoleRecord[];
}

@Injectable()
export class ConsoleParser {
  parse(records: ConsoleRecord[]): ConsoleReport {
    const messagesByType: Record<string, number> = {};

    for (const record of records) {
      messagesByType[record.type] =
        (messagesByType[record.type] ?? 0) + 1;
    }

    return {
      summary: {
        totalMessages: records.length,

        errors: records.filter(
          (record) =>
            record.source === 'pageerror' || record.type === 'error',
        ).length,

        warnings: records.filter(
          (record) => record.type === 'warning',
        ).length,

        pageErrors: records.filter(
          (record) => record.source === 'pageerror',
        ).length,

        messagesByType,
      },

      messages: records,
    };
  }
}