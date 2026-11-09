import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';

import { DatabaseModule } from 'src/database/database.module';
import { MarketModule } from 'src/market/market.module';
import { OrdersModule } from 'src/orders/orders.module';

import { ScheduleModule } from '@nestjs/schedule';
import { ExchangeDataModule } from './exchange-data/exchange-data.module';
import { PcrStrategyModule } from './pcr-strategy/pcr-strategy.module';

@Module({
  imports: [
    DatabaseModule,
    MarketModule,
    OrdersModule,

    ExchangeDataModule,
    ScheduleModule.forRoot(),
    PcrStrategyModule,
  ],
  controllers: [],
  providers: [StrategyService], // 🔴 REQUIRED],
  exports: [StrategyService], // 👈 IMPORTANT (used by WebSocket module)
})
export class StrategyModule {}
