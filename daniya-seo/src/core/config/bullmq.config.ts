import { ConfigService } from '@nestjs/config';
import { BullRootModuleOptions } from '@nestjs/bullmq';

export const getBullMqConfig = (
  config: ConfigService,
): BullRootModuleOptions => ({
  prefix: config.get<string>('QUEUE_PREFIX', 'daniya-ai-seo'),

  connection: {
    host: config.getOrThrow<string>('REDIS_HOST'),
    port: config.get<number>('REDIS_PORT', 6379),
    username: config.get<string>('REDIS_USERNAME') || undefined,
    password: config.get<string>('REDIS_PASSWORD') || undefined,
    db: config.get<number>('REDIS_DB', 0),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  },

  defaultJobOptions: {
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  },
});

/* 
export const LIGHTHOUSE_QUEUE = 'lighthouse';
export const NETWORK_QUEUE = 'network';
imports: [
  BullModule.registerQueue({
    name: LIGHTHOUSE_QUEUE,
  }),
]
imports: [
  BullModule.registerQueue({
    name: NETWORK_QUEUE,
  }),
]
*/