import { Global, Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS } from './redis.constants';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const client = new Redis(cfg.getOrThrow<string>('REDIS_URL'), {
          lazyConnect: false,
          maxRetriesPerRequest: 3,
        });
        client.on('error', (err) => Logger.error(err.message, 'Redis'));
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}