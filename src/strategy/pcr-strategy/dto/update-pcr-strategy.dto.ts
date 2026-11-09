import { PartialType } from '@nestjs/mapped-types';
import { CreatePcrStrategyDto } from './create-pcr-strategy.dto';

export class UpdatePcrStrategyDto extends PartialType(CreatePcrStrategyDto) {}
