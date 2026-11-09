import { PartialType } from '@nestjs/mapped-types';
import { IsIn } from 'class-validator';
import { Transform } from 'class-transformer';
import { CreatePcrStrategyConfigDto } from './create-pcr-strategy-config.dto';

export class UpdatePcrStrategyConfigDto extends PartialType(
  CreatePcrStrategyConfigDto,
) {}

export class UpdatePcrStatusDto {
  @Transform(({ value }) => String(value).trim().toUpperCase())
  @IsIn(['ACTIVE', 'INACTIVE'])
  status: string;
}
