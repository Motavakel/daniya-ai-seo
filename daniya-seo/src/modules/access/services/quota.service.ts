import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import {
  AccessRepository,
  DbTransaction,
} from '../access.repository';

@Injectable()
export class QuotaService {
  constructor(
    private readonly accessRepository: AccessRepository,
  ) {}

  async reservePage(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<void> {
    const reserved = await this.accessRepository.tryReservePageQuota(
      cycleId,
      tx,
    );

    if (!reserved) {
      throw new ForbiddenException(
        'The page quota has been reached.',
      );
    }
  }


  async commitPage(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<void> {
    const committed =
      await this.accessRepository.commitReservedPageQuota(
        cycleId,
        tx,
      );

    if (!committed) {
      throw new ConflictException(
        'No pending page reservation is available to commit.',
      );
    }
  }


  async releasePage(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<void> {
    const released =
      await this.accessRepository.releaseReservedPageQuota(
        cycleId,
        tx,
      );

    if (!released) {
      throw new ConflictException(
        'No pending page reservation is available to release.',
      );
    }
  }
}