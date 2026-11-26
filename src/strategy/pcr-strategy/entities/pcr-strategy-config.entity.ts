import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ObjectIdColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ObjectId } from 'mongodb';

@Entity('pcr_strategy_configs')
@Index(['contractName', 'pcrExpiry'], { unique: true })
export class PcrStrategyConfigEntity {
  @ObjectIdColumn() id: ObjectId;

  @Column() contractName: string; // NIFTY, SENSEX, GOLDM (PCR source)
  @Column() pcrExchange: string; // NFO | BFO | MCX
  @Column() pcrExpiry: string; // 09-NOV-2026

  @Column() tradeExchange: string; // NSE | NFO | BSE | BFO | MCX
  @Column() tradeInstrumentType: string; // FUTIDX | FUTSTK | OPTIDX | OPTSTK (+ FUTCOM | OPTFUT for MCX)
  @Column() tradeContractName: string; // NIFTY, SENSEX, GOLDM
  @Column() tradeExpiry: string; // 23-NOV-2026

  @Column() timeframeMinutes: number;
  @Column() lotsPerTrade: number;
  @Column() status: string; // ACTIVE | INACTIVE
  // @Column() pcrStartLevel: number; // default 1
  @Column() pcrBullishStartLevel: number; // default 1.2
  @Column() pcrBearishStartLevel: number; // default 0.8
  @Column() side: string; // BUY | SELL

  // optional extras
  @Column() pcrStep: number; // default 0.1
  @Column({ nullable: true })
  pcrBullishStep?: number;

  @Column({ nullable: true })
  pcrBearishStep?: number;
  @Column() productType: string; // default 'M'
  @Column() underlyingExchange?: string; // e.g. NSE
  @Column() underlyingToken?: string; // e.g. 26000
  @Column() strikesAroundAtm: number; // 0 = all

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
