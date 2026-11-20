import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AccessModule } from '../access/access.module';
import { WorkflowRepository } from './workflow.repository';
import { IdempotencyService } from './services/idempotency.service';
import { PageResolverService } from './services/page-resolver.service';
import { SlotReservationService } from './services/slot-reservation.service';
import { WorkflowService } from './services/workflow.service';

@Module({
  imports: [
    DatabaseModule,
    AccessModule,

    BullModule.registerQueue({
      name: 'seo-scans',
    }),
  ],

  providers: [
    WorkflowRepository,
    IdempotencyService,
    PageResolverService,
    SlotReservationService,
    WorkflowService,
  ],

  exports: [WorkflowService],
})
export class WorkflowModule {}