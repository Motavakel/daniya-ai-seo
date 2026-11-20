import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    const key = request.headers['idempotency-key'];

    if (typeof key !== 'string' || !key.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    return key.trim();
  },
);