import { Injectable } from '@nestjs/common';

import type { PlanLevel } from '../access.repository';

export interface ResolvedPlan {
  planLevel: PlanLevel;
  pageLimit: 5 | 30;
}

@Injectable()
export class PlanResolverService {
  resolve(planLevel: PlanLevel): ResolvedPlan {
    switch (planLevel) {
      case 'basic':
        return {
          planLevel: 'basic',
          pageLimit: 5,
          engines: ['lighthouse'],
        };

      case 'pro':
        return {
          planLevel: 'pro',
          pageLimit: 30,
            engines: [
            'lighthouse',
            'chrome_performance',
            'network',
            'console',
          ],
        };
    }
  }
}