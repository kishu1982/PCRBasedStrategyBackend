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
import { MarketService } from 'src/market/market.service';

/*
Every 5s: reads the snapshot, compares with live positions, plans and places orders, and records the result
*/

export interface PlannedOrder {
  exchange: string;
  token: string; // for plending order price required
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

const LIMIT_BUFFER = 0.001; // 0.1% beyond best price so the LMT order still fills

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
    private readonly market: MarketService,
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

  /** LMT price: BUY = best ask +0.1%, SELL = best bid -0.1%, rounded to tick. Falls back to LTP. */
  private async getLimitPrice(
    exchange: string,
    token: string,
    side: 'B' | 'S',
  ): Promise<number | null> {
    try {
      const q: any = await this.market.getQuotes({ exch: exchange, token });
      if (!q || q.stat !== 'Ok') return null;

      const ref = Number(side === 'B' ? q.sp1 : q.bp1);
      const base = ref > 0 ? ref : Number(q.lp);
      if (!(base > 0)) return null;

      const tick = Number(this.env.get('PCR_TICK_SIZE') ?? 0.05);
      const raw =
        side === 'B' ? base * (1 + LIMIT_BUFFER) : base * (1 - LIMIT_BUFFER);
      // round in the safe direction: buy rounds up, sell rounds down
      const steps =
        side === 'B'
          ? Math.ceil(raw / tick - 1e-6)
          : Math.floor(raw / tick + 1e-6);
      const price = Math.round(steps * tick * 100) / 100;
      return price >= tick ? price : null;
    } catch (e: any) {
      this.logger.error(`PCR getLimitPrice failed: ${e?.message}`);
      return null;
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

    const executionEnabled = this.env.get('PCR_EXECUTION_ENABLED') === 'true';

    // cancel our own pending LMT orders first, so an unfilled order is not placed twice
    if (executionEnabled) {
      if (!(await this.cancelPendingPcrOrders(c)))
        return skip('Could not check pending orders');
    }

    const live = await this.calc.fetchNetPositions(true); // syncs trade book right now, then reads filtered trades
    if (!live.ok) return skip('Net positions unavailable');

    const universe = await this.calc.getTradeUniverse(c);
    const positions = this.calc
      .mapPositions(universe, live.rows)
      .filter((p) => p.netQty !== 0);

    const target = snap.contractToTrade;
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
          token: p.token,
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
        token: target.token,
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
          token: p.token,
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

    if (!executionEnabled) {
      this.logger.log(`PCR ${c.contractName} DRY RUN: ${JSON.stringify(plan)}`);
      this.calc.recordExecution(id, { ...info, status: 'DRY_RUN' });
      return { status: 'DRY_RUN' as const, orders: plan };
    }

    // 3) place LMT orders sequentially; stop on first failure (e.g. don't open if close failed)
    const results: any[] = [];
    for (const o of plan) {
      try {
        const price = await this.getLimitPrice(o.exchange, o.token, o.side);
        if (price == null) throw new Error('Limit price unavailable');

        const r: any = await this.orders.placeOrder({
          buy_or_sell: o.side,
          product_type: c.productType ?? 'M',
          exchange: o.exchange,
          tradingsymbol: o.tradingSymbol,
          quantity: o.quantity,
          price_type: 'LMT',
          price,
          trigger_price: 0,
          discloseqty: 0,
          retention: 'DAY',
          amo: 'NO',
          remarks: `PCR_${c.contractName}`,
        } as PlaceOrderDto);

        // a rejected order may not throw, so check the response
        if (!r || r.stat !== 'Ok') throw new Error(r?.emsg ?? 'Order rejected');

        results.push({ ...o, price, ok: true, orderNo: r?.norenordno });
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

  private async cancelPendingPcrOrders(
    c: PcrStrategyConfigEntity,
  ): Promise<boolean> {
    try {
      const res: any = await this.orders.getOrderBook();
      if (res?.status !== 'OK') return false;
      const pending = (Array.isArray(res.trades) ? res.trades : []).filter(
        (o: any) =>
          String(o.remarks || '').includes(`PCR_${c.contractName}`) &&
          ['OPEN', 'PENDING', 'TRIGGER_PENDING'].includes(o.status),
      );
      for (const o of pending) {
        await this.orders.cancelOrder(o.norenordno);
        this.logger.warn(`PCR cancelled pending order ${o.norenordno}`);
      }
      if (pending.length) await new Promise((r) => setTimeout(r, 500));
      return true;
    } catch (e: any) {
      this.logger.error(`PCR cancel pending failed: ${e?.message}`);
      return false;
    }
  }
}
