import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { BrowserRunnerService } from './browser/browser-runner.service';

import { LighthouseEngine } from './lighthouse/lighthouse.engine';
import { LighthouseParser } from './lighthouse/lighthouse.parser';

import { NetworkEngine } from './network/network.engine';
import { NetworkParser } from './network/network.parser';

import { ConsoleEngine } from './console/console.engine';
import { ConsoleParser } from './console/console.parser';

import { PerformanceEngine } from './performance/performance.engine';
import { PerformanceParser } from './performance/performance.parser';

@Module({
  imports: [ConfigModule],

  providers: [
    BrowserRunnerService,

    LighthouseEngine,
    LighthouseParser,

    NetworkEngine,
    NetworkParser,

    ConsoleEngine,
    ConsoleParser,

    PerformanceEngine,
    PerformanceParser,
  ],

  exports: [
    BrowserRunnerService,

    LighthouseEngine,
    LighthouseParser,

    NetworkEngine,
    ConsoleEngine,
    PerformanceEngine,
  ],
})
export class EnginesModule {}