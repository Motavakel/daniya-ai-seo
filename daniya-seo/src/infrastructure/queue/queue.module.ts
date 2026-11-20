import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';

import { ConfigModule } from '../../core/config/config.module';
import { getBullMqConfig } from '../../core/config/bullmq.config';
import { SCAN_QUEUE_NAME } from './queue.constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: getBullMqConfig,
    }),

    BullModule.registerQueue({
      name: SCAN_QUEUE_NAME,
    }),
  ],

  exports: [BullModule],
})
export class QueueModule {}