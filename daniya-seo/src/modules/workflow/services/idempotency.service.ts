import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import { WorkflowRepository } from '../workflow.repository';
import type { DbTransaction } from '../workflow.repository';

interface FindExistingScanInput {
  customerId: string;
  idempotencyKey: string;
  requestHash: string;
}

interface CreateIdempotencyRecordInput {
  customerId: string;
  idempotencyKey: string;
  requestHash: string;
  scanId: string;
}

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly workflowRepository: WorkflowRepository,
  ) {}

  createRequestHash(payload: Record<string, unknown>): string {
    const normalizedPayload = this.sortObjectKeys(payload);

    return createHash('sha256')
      .update(JSON.stringify(normalizedPayload))
      .digest('hex');
  }

  async findExistingScan(
    input: FindExistingScanInput,
    tx: DbTransaction,
  ) {
    await this.workflowRepository.lockIdempotencyKey(
      input.customerId,
      input.idempotencyKey,
      tx,
    );

    const record =
      await this.workflowRepository.findIdempotencyRecord(
        input.customerId,
        input.idempotencyKey,
        tx,
      );

    if (!record) return null;

    if (record.requestHash !== input.requestHash) {
      throw new ConflictException(
        'Idempotency key was already used with a different request.',
      );
    }

    const scan = await this.workflowRepository.findScanById(
      record.scanId,
      tx,
    );

    if (!scan) {
      throw new InternalServerErrorException(
        'Idempotency record references a missing scan.',
      );
    }

    return scan;
  }

  async createRecord(
    input: CreateIdempotencyRecordInput,
    tx: DbTransaction,
  ) {
    return this.workflowRepository.createIdempotencyRecord(
      input,
      tx,
    );
  }

  private sortObjectKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortObjectKeys(item));
    }

    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>;

      return Object.keys(object)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          result[key] = this.sortObjectKeys(object[key]);
          return result;
        }, {});
    }

    return value;
  }
}