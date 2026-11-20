import { IsIn } from 'class-validator';

export class RepurchaseDto {
  @IsIn(['basic', 'pro'], { message: 'plan must be "basic" or "pro".' })
  plan!: 'basic' | 'pro';
}