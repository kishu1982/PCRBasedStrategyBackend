import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

const upper = ({ value }: { value: any }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const EXPIRY = /^\d{2}-[A-Za-z]{3}-\d{4}$/;
const EXPIRY_MSG = 'must look like 09-NOV-2026';

export class CreatePcrStrategyConfigDto {
  @Transform(upper) @IsString() @IsNotEmpty() contractName: string;
  @Transform(upper) @IsIn(['NFO', 'BFO', 'MCX']) pcrExchange: string;
  @Transform(upper)
  @Matches(EXPIRY, { message: `pcrExpiry ${EXPIRY_MSG}` })
  pcrExpiry: string;

  @Transform(upper)
  @IsIn(['NSE', 'NFO', 'BSE', 'BFO', 'MCX'])
  tradeExchange: string;
  @Transform(upper)
  @IsIn(['FUTIDX', 'FUTSTK', 'OPTIDX', 'OPTSTK', 'FUTCOM', 'OPTFUT'])
  tradeInstrumentType: string;
  @Transform(upper) @IsString() @IsNotEmpty() tradeContractName: string;
  @Transform(upper)
  @Matches(EXPIRY, { message: `tradeExpiry ${EXPIRY_MSG}` })
  tradeExpiry: string;

  @IsInt() @Min(1) timeframeMinutes: number;
  @IsInt() @Min(1) lotsPerTrade: number;

  @IsOptional() @Transform(upper) @IsIn(['ACTIVE', 'INACTIVE']) status?: string;
  @IsOptional() @IsNumber() @Min(0) pcrStartLevel?: number;
  @Transform(upper) @IsIn(['BUY', 'SELL']) side: string;

  @IsOptional() @IsNumber() @Min(0.01) pcrStep?: number;
  @IsOptional() @Transform(upper) @IsIn(['C', 'M', 'H']) productType?: string;
  @IsOptional()
  @Transform(upper)
  @IsIn(['NSE', 'BSE', 'NFO', 'BFO', 'MCX'])
  underlyingExchange?: string;
  @IsOptional() @IsString() underlyingToken?: string;
}
