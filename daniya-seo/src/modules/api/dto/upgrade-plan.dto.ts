import { IsIn, IsString, Length } from "class-validator";

export class UpgradePlanDto {
  @IsIn(['pro'])
  target_plan!: 'pro';

  @IsString()
  @Length(8, 128)
  payment_reference!: string;
}