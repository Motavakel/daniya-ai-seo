import { Module } from '@nestjs/common';
import { RepositoriesModule } from '../../../infrastructure/database/repositories/repositories.module';
import { NetworkDiagnosticEngine } from '../domain/network-diagnostic.engine';
import { NetworkDiagnosticsService } from './network-diagnostics.service';

@Module({
  imports: [RepositoriesModule],
  providers: [NetworkDiagnosticEngine, NetworkDiagnosticsService],
  exports: [NetworkDiagnosticsService],
})
export class DiagnosticsModule {}
