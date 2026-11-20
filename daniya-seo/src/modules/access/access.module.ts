import { Module } from '@nestjs/common';

import { AccessRepository } from './access.repository';

import { PlanResolverService } from './services/plan-resolver.service';
import { QuotaService } from './services/quota.service';
import { CycleLifecycleService } from './services/cycle-lifecycle.service';
import { AccessService } from './services/access.service';

@Module({
  providers: [
    AccessRepository,
    PlanResolverService,
    QuotaService,
    CycleLifecycleService,
    AccessService,
  ],
  exports: [
    AccessService,
    CycleLifecycleService,
  ],
})
export class AccessModule {}