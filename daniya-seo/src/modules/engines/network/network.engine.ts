import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';

import {
  NetworkParser,
  NetworkParserOptions,
  NetworkReport,
} from './network.parser';

@Injectable()
export class NetworkEngine {
  private readonly logger = new Logger(NetworkEngine.name);

  constructor(private readonly parser: NetworkParser) {}

  async run(
    netLogPath: string,
    options: Omit<NetworkParserOptions, 'rawNetLogBytes'>,
  ): Promise<NetworkReport> {
    try {
      const rawNetLog = await readFile(netLogPath, 'utf8');

      if (!rawNetLog.trim()) {
        throw new Error('NetLog file is empty.');
      }

      const netLog = JSON.parse(rawNetLog) as unknown;

      return this.parser.parse(netLog, {
        ...options,
        rawNetLogBytes: Buffer.byteLength(rawNetLog, 'utf8'),
      });
    } catch (error: unknown) {
      const cause =
        error instanceof Error ? error : new Error(String(error));

      this.logger.error(
        'Network report generation failed.',
        cause.stack,
      );

      throw new Error('Network report generation failed.', {
        cause,
      });
    }
  }
}