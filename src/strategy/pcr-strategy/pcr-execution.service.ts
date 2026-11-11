import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrdersService } from 'src/orders/orders.service'; // adjust
import { PlaceOrderDto } from 'src/orders/dto/place-order.dto'; // adjust
import { PcrStrategyConfigService } from './pcr-strategy-config.service';
import { PcrCalculationService } from './pcr-calculation.service';
import { PcrStrategyConfigEntity } from './entities/pcr-strategy-config.entity';

/*
Every 5s: reads the snapshot, compares with live positions, plans and places orders, and records the result
*/

export interface PlannedOrder {
  exchange: string;
  tradingSymbol: string;
  side: 'B' | 'S';
  quantity: number; // units = lots * lotSize
  reason: string;
}

export interface PcrExecutionResult {
  status: 'SKIPPED' | 'NOOP' | 'DRY_RUN' | 'EXECUTED' | 'FAILED';
  reason?: string;
  orders: (
    | PlannedOrder
    | (PlannedOrder & { ok: boolean; orderNo?: string; error?: string })
  )[];
}

// IST minutes-of-day session windows
const SESSIONS: Record<string, [number, number]> = {
  NSE: [555, 930],
  NFO: [555, 930],
  BSE: [555, 930],
  BFO: [555, 930],
  MCX: [540, 1410],
};
const IST_MS = 330 * 60 * 1000;

@Injectable()
export class PcrExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PcrExecutionService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly lastBucket = new Map<string, number>();
  private readonly busy = new Set<string>();

  constructor(
    private readonly configService: PcrStrategyConfigService,
    private readonly calc: PcrCalculationService,
    private readonly orders: OrdersService,
    private readonly env: ConfigService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.scan().catch((e) =>
        this.logger.error(`PCR scan failed: ${e?.message}`),
      );
    }, 5000); // every 5 seconds, regardless of timeframe, but each config runs only once per bucket
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private inSession(exchange: string) {
    const ist = new Date(Date.now() + IST_MS);
    const day = ist.getUTCDay();
    if (day === 0 || day === 6) return false;
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const [s, e] = SESSIONS[exchange] ?? [555, 930];
    return mins >= s && mins <= e;
  }

  /** every 5s: run each ACTIVE config once per timeframe bucket (clock aligned, IST) */
  private async scan() {
    const configs = await this.configService.getActiveConfigs();
    for (const c of configs) {
      const id = String(c.id);
      if (this.busy.has(id)) continue;
      const bucket = Math.floor(
        (Date.now() + IST_MS) / (c.timeframeMinutes * 60_000),
      );
      if (this.lastBucket.get(id) === bucket) continue;
      if (!this.inSession(c.tradeExchange)) continue;

      this.busy.add(id);
      try {
        const res = await this.rebalance(c);
        if (res.status !== 'SKIPPED') this.lastBucket.set(id, bucket); // skipped = retry in 5s
      } catch (e: any) {
        this.logger.error(
          `PCR rebalance error ${c.contractName}: ${e?.message}`,
        );
        this.lastBucket.set(id, bucket);
      } finally {
        this.busy.delete(id);
      }
    }
  }

  /** manual trigger for testing (ignores timeframe + session, still needs ACTIVE) */
  async runNow(id: string): Promise<PcrExecutionResult> {
    const c = await this.configService.findById(id);
    if (c.status !== 'ACTIVE')
      return { status: 'SKIPPED', reason: 'Config is INACTIVE', orders: [] };
    if (this.busy.has(id))
      return { status: 'SKIPPED', reason: 'Already running', orders: [] };
    this.busy.add(id);
    try {
      return await this.rebalance(c);
    } finally {
      this.busy.delete(id);
    }
  }

  private async rebalance(
    c: PcrStrategyConfigEntity,
  ): Promise<PcrExecutionResult> {
    const id = String(c.id);
    const skip = (reason: string) => {
      this.logger.warn(`PCR ${c.contractName}: skipped - ${reason}`);
      return {
        status: 'SKIPPED' as const,
        reason,
        orders: [] as PlannedOrder[],
      };
    };

    const snap = await this.calc.readSnapshot(c);
    if (!snap) return skip('No snapshot yet');
    if (!snap.strategyActive) return skip('Strategy inactive in snapshot');
    if (Date.now() - new Date(snap.updatedAt).getTime() > 30_000)
      return skip('Snapshot is stale');
    if (snap.pcr == null || snap.feed.coverage < 0.9)
      return skip('PCR feed incomplete');
    if (!snap.contractToTrade)
      return skip(snap.contractReason ?? 'No contract to trade');

    // const live = await this.calc.fetchNetPositions();
    // if (!live.ok) return skip('Net positions unavailable'); // never assume "flat" on an API failure
    const live = await this.calc.fetchNetPositions(true); // syncs trade book right now, then reads filtered trades
    if (!live.ok) return skip('Net positions unavailable');

    const universe = await this.calc.getTradeUniverse(c);
    const positions = this.calc
      .mapPositions(universe, live.rows)
      .filter((p) => p.netQty !== 0);

    const target = snap.contractToTrade;
    // const dir = c.side === 'BUY' ? 1 : -1;
    // const isOpt = c.tradeInstrumentType.startsWith('OPT');
    // const openSide: 'B' | 'S' = c.side === 'BUY' ? 'B' : 'S';
    // const closeSide: 'B' | 'S' = openSide === 'B' ? 'S' : 'B';
    const isOpt = c.tradeInstrumentType.startsWith('OPT');
    // options: config side. futures: PCR decides, config side is ignored
    const effSide: 'BUY' | 'SELL' = isOpt
      ? (c.side as 'BUY' | 'SELL')
      : snap.pcr >= 1
        ? 'BUY'
        : 'SELL';
    const dir = effSide === 'BUY' ? 1 : -1;
    const openSide: 'B' | 'S' = effSide === 'BUY' ? 'B' : 'S';
    const closeSide: 'B' | 'S' = openSide === 'B' ? 'S' : 'B';
    const lotSize = target.lotSize || 1;
    const isTargetRow = (p: { exchange: string; token: string }) =>
      p.exchange === target.exchange && p.token === target.token;

    const plan: PlannedOrder[] = [];
    const counted: typeof positions = []; // positions that count toward the lot total

    // 1) close what must not exist: wrong direction, or (options) wrong CE/PE side, (futures) any other contract
    for (const p of positions) {
      const wrongDir = Math.sign(p.netQty) !== dir;
      const wrongType = isOpt ? p.optType !== snap.optionType : !isTargetRow(p);
      if (wrongDir || wrongType) {
        plan.push({
          exchange: p.exchange,
          tradingSymbol: p.tradingSymbol,
          side: p.netQty > 0 ? 'S' : 'B',
          quantity: Math.abs(p.netQty),
          reason: wrongDir
            ? 'close wrong-direction position'
            : 'close position on wrong CE/PE side or contract',
        });
      } else {
        counted.push(p);
      }
    }

    // 2) total lots across ALL counted contracts
    const heldLots = counted.reduce(
      (s, p) => s + Math.abs(p.netQty) / p.lotSize,
      0,
    );

    const maxLots = Number(this.env.get('PCR_MAX_LOTS') ?? 100);
    const targetLots = Math.min(snap.lots.targetLots, maxLots);
    if (snap.lots.targetLots > maxLots)
      this.logger.warn(`Target lots clamped to PCR_MAX_LOTS=${maxLots}`);

    const diff = Math.round(targetLots - heldLots);

    if (diff > 0) {
      // add at the snapshot contract
      plan.push({
        exchange: target.exchange,
        tradingSymbol: target.tradingSymbol,
        side: openSide,
        quantity: diff * lotSize,
        reason: `add ${diff} lots`,
      });
    } else if (diff < 0) {
      // reduce: cut non-snapshot strikes first, then the snapshot strike
      let toCut = -diff;
      const ordered = [...counted].sort(
        (a, b) => Number(isTargetRow(a)) - Number(isTargetRow(b)),
      );
      for (const p of ordered) {
        if (toCut <= 0) break;
        const lots = Math.abs(p.netQty) / p.lotSize;
        const cut = Math.min(lots, toCut);
        plan.push({
          exchange: p.exchange,
          tradingSymbol: p.tradingSymbol,
          side: closeSide,
          quantity: cut * p.lotSize,
          reason: `reduce ${cut} lots`,
        });
        toCut -= cut;
      }
    }

    const info: any = {
      at: new Date().toISOString(),
      pcr: snap.pcr,
      targetLots,
      heldLots,
      plan,
    };

    if (!plan.length) {
      this.calc.recordExecution(id, { ...info, status: 'NOOP' });
      return {
        status: 'NOOP' as const,
        reason: 'Already in line with PCR',
        orders: plan,
      };
    }

    if (this.env.get('PCR_EXECUTION_ENABLED') !== 'true') {
      this.logger.log(`PCR ${c.contractName} DRY RUN: ${JSON.stringify(plan)}`);
      this.calc.recordExecution(id, { ...info, status: 'DRY_RUN' });
      return { status: 'DRY_RUN' as const, orders: plan };
    }

    // 3) place orders sequentially; stop on first failure (e.g. don't open if close failed)
    const results: any[] = [];
    for (const o of plan) {
      try {
        const r = await this.orders.placeOrder({
          buy_or_sell: o.side,
          product_type: c.productType ?? 'M',
          exchange: o.exchange,
          tradingsymbol: o.tradingSymbol,
          quantity: o.quantity,
          price_type: 'MKT',
          retention: 'DAY',
          remarks: `PCR_${c.contractName}`,
        } as PlaceOrderDto);
        results.push({ ...o, ok: true, orderNo: r?.norenordno });
      } catch (e: any) {
        results.push({ ...o, ok: false, error: e?.message });
        this.logger.error(`PCR order failed ${o.tradingSymbol}: ${e?.message}`);
        this.calc.recordExecution(id, { ...info, status: 'FAILED', results });
        return { status: 'FAILED' as const, orders: results };
      }
    }
    this.calc.recordExecution(id, { ...info, status: 'EXECUTED', results });
    return { status: 'EXECUTED' as const, orders: results };
  }
}
