import { Module } from '@nestjs/common';
import { ConfigModule } from '../../../core/config/config.module';
import { RepositoriesModule } from '../../../infrastructure/database/repositories/repositories.module';
import { SecurityModule } from '../../security/security.module';
import { NetworkEngineService } from './network-engine.service';
import { NetLogParser } from '../domain/netlog-parser';
import { ChromeNetLogRunner } from '../infrastructure/chrome-netlog.runner';
import { NetworkArtifactStorageService } from '../infrastructure/network-artifact-storage.service';

@Module({
  imports: [ConfigModule, RepositoriesModule, SecurityModule],
  providers: [
    NetworkEngineService,
    NetLogParser,
    ChromeNetLogRunner,
    NetworkArtifactStorageService,
  ],
  exports: [NetworkEngineService],
})
export class NetworkEngineModule {}
