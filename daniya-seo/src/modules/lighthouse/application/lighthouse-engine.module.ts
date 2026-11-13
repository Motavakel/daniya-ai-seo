import { Module } from '@nestjs/common';
import { ConfigModule } from '../../../core/config/config.module';
import { RepositoriesModule } from '../../../infrastructure/database/repositories/repositories.module';
import { SecurityModule } from '../../security/security.module';
import { LighthouseEngineService } from './lighthouse-engine.service';
import { LighthouseReportParser } from '../domain/lighthouse-report.parser';
import { LighthouseProcessRunner } from '../infrastructure/lighthouse-process.runner';
import { LocalArtifactStorageService } from '../infrastructure/local-artifact-storage.service';

@Module({
  imports: [ConfigModule, RepositoriesModule, SecurityModule],
  providers: [
    LighthouseEngineService,
    LighthouseReportParser,
    LighthouseProcessRunner,
    LocalArtifactStorageService,
  ],
  exports: [LighthouseEngineService, LighthouseProcessRunner, LocalArtifactStorageService],
})
export class LighthouseEngineModule {}
