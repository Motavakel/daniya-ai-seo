import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';

/** BullMQ owns its Redis connections. No separate Redis client/service is needed. */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const username = config.get<string>('REDIS_USERNAME');
        const password = config.get<string>('REDIS_PASSWORD');
        const useTls = config.get<boolean>('REDIS_TLS', false);
        return {
          prefix: config.get<string>('QUEUE_PREFIX', 'daniya-ai-seo'),
          connection: {
            host: config.getOrThrow<string>('REDIS_HOST'),
            port: config.get<number>('REDIS_PORT', 6379),
            username: username || undefined,
            password: password || undefined,
            db: config.get<number>('REDIS_DB', 0),
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            ...(useTls ? { tls: {} } : {}),
          },
        };
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
