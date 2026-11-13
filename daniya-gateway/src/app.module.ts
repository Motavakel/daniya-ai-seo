import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { CustomersModule } from './modules/customers/customers.module';
import { ScansModule } from './modules/scans/scans.module';
import { ConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';


@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    AuthModule,
    CustomersModule,
    ScansModule,
  ],
  providers: [],
})
export class AppModule {}