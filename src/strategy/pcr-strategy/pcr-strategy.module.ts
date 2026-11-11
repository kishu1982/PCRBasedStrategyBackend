import { Module } from '@nestjs/common';
import { PcrStrategyService } from './pcr-strategy.service';
import { PcrStrategyController } from './pcr-strategy.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PcrStrategyConfigEntity } from './entities/pcr-strategy-config.entity';
import { PcrStrategyConfigService } from './pcr-strategy-config.service';
import { PcrInstrumentService } from './pcr-instrument.service';
import { PcrCalculationService } from './pcr-calculation.service';
import { PcrExecutionService } from './pcr-execution.service';
import { OrdersModule } from 'src/orders/orders.module'; // adjust; must export OrdersService
import { ExchangeDataModule } from '../exchange-data/exchange-data.module';
import { MarketModule } from '@/market/market.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PcrStrategyConfigEntity]),
    OrdersModule,
    ExchangeDataModule,
    MarketModule,
  ],
  controllers: [PcrStrategyController],
  providers: [
    PcrStrategyService,
    PcrStrategyConfigService,
    PcrInstrumentService,
    PcrCalculationService,
    PcrExecutionService,
  ],
  exports: [PcrCalculationService],
})
export class PcrStrategyModule {}
