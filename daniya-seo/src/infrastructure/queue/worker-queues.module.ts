import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LIGHTHOUSE_QUEUE, NETWORK_QUEUE } from './queue.constants';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: LIGHTHOUSE_QUEUE },
      { name: NETWORK_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class WorkerQueuesModule {}
