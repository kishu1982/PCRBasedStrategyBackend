import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs-extra';
import * as path from 'path';
import { OrdersService } from 'src/orders/orders.service'; // adjust
import { PcrStrategyConfigService } from './pcr-strategy-config.service';
import { PcrInstrumentService } from './pcr-instrument.service';
import { PcrStrategyConfigEntity } from './entities/pcr-strategy-config.entity';
import { PcrInstrument, PcrPosition, PcrSnapshot } from './pcr-strategy.types';

import { ExchangeDataService } from 'src/strategy/exchange-data/exchange-data.service';

/*
Every 10s: sums OI to get PCR, computes target lots, picks the contract, lists open positions, writes the snapshot JSON, deletes orphan snapshots, and holds the tick cache and subscription list
*/

interface PcrNetRow {
  exch: string;
  token: string;
  tsym: string;
  netQty: number;
  avgPrice: number;
  cashflow: number; // sell amount - buy amount
}

// export function computeLots(
//   pcr: number | null,
//   start: number,
//   step: number,
//   lotsPerTrade: number,
// ) {
//   if (pcr == null)
//     return {
//       direction: 'NA' as const,
//       pcrLots: 0,
//       lotsPerTrade,
//       targetLots: 0,
//     };
//   const diff = pcr >= start ? pcr - start : start - pcr;
//   // toFixed guards float error: (1.2 - 1) / 0.1 = 1.9999999 would floor to 1
//   const pcrLots = Math.floor(Number((diff / step).toFixed(6)));
//   return {
//     direction:
//       pcr > start
//         ? ('ABOVE' as const)
//         : pcr < start
//           ? ('BELOW' as const)
//           : ('AT' as const),
//     pcrLots,
//     lotsPerTrade,
//     targetLots: pcrLots * lotsPerTrade,
//   };
// }
export function computeLots(
  pcr: number | null,
  bearish: number,
  bullish: number,
  step: number,
  lotsPerTrade: number,
) {
  if (pcr == null)
    return {
      direction: 'NA' as const,
      pcrLots: 0,
      lotsPerTrade,
      targetLots: 0,
    };

  let direction: 'ABOVE' | 'BELOW' | 'NEUTRAL' = 'NEUTRAL';
  let diff = 0;
  if (pcr > bullish) {
    direction = 'ABOVE';
    diff = pcr - bullish;
  } else if (pcr < bearish) {
    direction = 'BELOW';
    diff = bearish - pcr;
  }
  const pcrLots = Math.floor(Number((diff / step).toFixed(6)));
  return {
    direction,
    pcrLots,
    lotsPerTrade,
    targetLots: pcrLots * lotsPerTrade,
  };
}

const pcrOptionInstrument = (exchange: string) =>
  exchange === 'MCX' ? 'OPTFUT' : 'OPTIDX';
const keyOf = (r: { exchange: string; token: string }) =>
  `${r.exchange}|${r.token}`;

@Injectable()
export class PcrCalculationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PcrCalculationService.name);
  private readonly DATA_DIR = path.join(process.cwd(), 'data', 'pcrStrategy');
  private readonly CYCLE_MS = 10_000;

  private readonly ticks = new Map<string, { lp?: number; oi?: number }>();
  private required = new Set<string>();
  private readonly lastExecution = new Map<string, any>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly configService: PcrStrategyConfigService,
    private readonly instruments: PcrInstrumentService,
    private readonly orders: OrdersService,
    private readonly exchangeData: ExchangeDataService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.runCycle(), this.CYCLE_MS);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ---------- hooks used by WebsocketService ---------- */

  getRequiredSubscriptions(): string[] {
    return Array.from(this.required);
  }

  onTick(tick: any) {
    if (!tick?.e || !tick?.tk) return;
    const key = `${tick.e}|${tick.tk}`;
    if (!this.required.has(key)) return;
    const cur = this.ticks.get(key) ?? {};
    // 'tf' ticks only carry changed fields, so merge into the cache
    if (tick.lp !== undefined && Number(tick.lp) > 0) cur.lp = Number(tick.lp);
    if (tick.oi !== undefined && !Number.isNaN(Number(tick.oi)))
      cur.oi = Number(tick.oi);
    this.ticks.set(key, cur);
  }

  recordExecution(configId: string, info: any) {
    this.lastExecution.set(configId, info);
  }

  /* ---------- positions ---------- */

  /** Net positions from MAGIC-tagged trades whose remarks also contain 'PCR_' (our own orders only). */
  // async fetchNetPositions(
  //   fresh = false,
  // ): Promise<{ ok: boolean; rows: PcrNetRow[] }> {
  //   if (fresh) await this.exchangeData.forceSyncFromWebsocket(true);

  //   const map = new Map<string, any>();
  //   for (const t of this.exchangeData.getFilteredTrades()) {
  //     const r = t.raw || t;
  //     if (!String(r.remarks || '').includes('PCR_')) continue;

  //     const key = `${r.exch}|${r.token}`;
  //     const qty = Number(r.flqty ?? r.qty ?? 0);
  //     const prc = Number(r.flprc ?? r.avgprc ?? r.prc ?? 0);
  //     const cur = map.get(key) ?? {
  //       exch: r.exch,
  //       token: String(r.token),
  //       tsym: r.tsym,
  //       buyQty: 0,
  //       sellQty: 0,
  //       buyAmt: 0,
  //       sellAmt: 0,
  //     };
  //     if (r.trantype === 'B') {
  //       cur.buyQty += qty;
  //       cur.buyAmt += qty * prc;
  //     } else if (r.trantype === 'S') {
  //       cur.sellQty += qty;
  //       cur.sellAmt += qty * prc;
  //     }
  //     map.set(key, cur);
  //   }

  //   const rows: PcrNetRow[] = [...map.values()].map((c) => {
  //     const netQty = c.buyQty - c.sellQty;
  //     const avgPrice =
  //       netQty > 0
  //         ? c.buyAmt / c.buyQty
  //         : netQty < 0
  //           ? c.sellAmt / c.sellQty
  //           : 0;
  //     return {
  //       exch: c.exch,
  //       token: c.token,
  //       tsym: c.tsym,
  //       netQty,
  //       avgPrice,
  //       cashflow: c.sellAmt - c.buyAmt,
  //     };
  //   });
  //   return { ok: true, rows };
  // }
  /** Net positions straight from the broker (includes carried-forward positions, no remarks/magic filter). */
  async fetchNetPositions(): Promise<{ ok: boolean; rows: PcrNetRow[] }> {
    try {
      const res: any = await this.orders.getNetPositions();

      if (!res?.success) {
        // some brokers answer "no data" for a flat account; treat that as empty, anything else as a failure
        const msg = String(res?.message ?? res?.emsg ?? '').toLowerCase();
        if (msg.includes('no data')) return { ok: true, rows: [] };
        return { ok: false, rows: [] }; // never assume "flat" on an API failure
      }

      const map = new Map<string, PcrNetRow>();
      for (const p of Array.isArray(res.data) ? res.data : []) {
        const netQty = Number(p.netqty || 0);
        const cashflow =
          Number(p.totsellamt ?? p.daysellamt ?? 0) -
          Number(p.totbuyamt ?? p.daybuyamt ?? 0);
        const key = `${p.exch}|${p.token}`;
        const cur = map.get(key);
        if (cur) {
          // same contract under different product types: add them up
          if (cur.netQty === 0) cur.avgPrice = Number(p.netavgprc || 0);
          cur.netQty += netQty;
          cur.cashflow += cashflow;
        } else {
          map.set(key, {
            exch: p.exch,
            token: String(p.token),
            tsym: p.tsym,
            netQty,
            avgPrice: Number(p.netavgprc || 0),
            cashflow,
          });
        }
      }
      return { ok: true, rows: [...map.values()] };
    } catch (e: any) {
      this.logger.error(`Broker net positions failed: ${e?.message}`);
      return { ok: false, rows: [] };
    }
  }

  async getTradeUniverse(
    cfg: PcrStrategyConfigEntity,
  ): Promise<PcrInstrument[]> {
    return this.instruments.find({
      exchange: cfg.tradeExchange,
      symbol: cfg.tradeContractName,
      instrument: cfg.tradeInstrumentType,
      expiry: cfg.tradeExpiry,
    });
  }

  mapPositions(universe: PcrInstrument[], rows: PcrNetRow[]): PcrPosition[] {
    const byKey = new Map(universe.map((u) => [keyOf(u), u]));
    const byTsym = new Map(universe.map((u) => [u.tradingSymbol, u]));
    const out: PcrPosition[] = [];
    for (const p of rows) {
      const u = byKey.get(`${p.exch}|${p.token}`) ?? byTsym.get(p.tsym);
      if (!u) continue;
      const lotSize = u.lotSize || 1;
      const ltp = this.ticks.get(keyOf(u))?.lp ?? 0;
      out.push({
        exchange: u.exchange,
        token: u.token,
        tradingSymbol: u.tradingSymbol,
        optType: u.optType,
        lotSize,
        netQty: p.netQty,
        netLots: p.netQty / lotSize,
        avgPrice: p.avgPrice,
        ltp,
        pnl: ltp > 0 ? p.cashflow + p.netQty * ltp : 0, // realised + open, from PCR trades only
      });
    }
    return out;
  }

  /* ---------- main cycle (every 10s) ---------- */

  private async runCycle() {
    if (this.running) return;
    this.running = true;
    try {
      const configs = await this.configService.findAll();
      await this.pruneOrphanSnapshots(configs); // fucntion to remove orphan snapshots that don't belong to any saved config
      if (!configs.length) {
        this.required = new Set();
        return;
      }

      const pos = await this.fetchNetPositions();
      const nextRequired = new Set<string>();

      for (const cfg of configs) {
        try {
          const snap = await this.buildSnapshot(cfg, pos, nextRequired);
          await this.writeSnapshot(cfg, snap);
        } catch (e: any) {
          this.logger.error(
            `PCR cycle failed for ${cfg.contractName} ${cfg.pcrExpiry}: ${e?.message}`,
          );
        }
      }
      this.required = nextRequired;
    } finally {
      this.running = false;
    }
  }

  private async resolveUnderlying(cfg: PcrStrategyConfigEntity) {
    if (cfg.underlyingExchange && cfg.underlyingToken) {
      return { exchange: cfg.underlyingExchange, token: cfg.underlyingToken };
    }
    // fallback: nearest future of the same symbol
    const fut = await this.instruments.findNearestFuture(
      cfg.pcrExchange,
      cfg.contractName,
      cfg.pcrExpiry, // notBefore: don't pick a future that expires before the PCR expiry
    );
    return fut ? { exchange: fut.exchange, token: fut.token } : null;
  }

  private async buildSnapshot(
    cfg: PcrStrategyConfigEntity,
    pos: { ok: boolean; rows: any[] },
    nextRequired: Set<string>,
  ): Promise<PcrSnapshot> {
    // --- PCR from the full option chain ---
    // --- PCR from the option chain (full, or N strikes around the underlying) ---
    const fullChain = await this.instruments.find({
      exchange: cfg.pcrExchange,
      symbol: cfg.contractName,
      instrument: pcrOptionInstrument(cfg.pcrExchange),
      expiry: cfg.pcrExpiry,
    });

    // underlying first, because the strike window depends on its LTP
    // const und = await this.resolveUnderlying(cfg);
    // let undLtp: number | null = null;
    // if (und) {
    //   nextRequired.add(keyOf(und));
    //   undLtp = this.ticks.get(keyOf(und))?.lp ?? null;
    // }

    // now use synthetic underlying (from the option chain) if the real underlying is not available
    // underlying first, because the strike window depends on its LTP
    const und = await this.resolveUnderlying(cfg);
    let spotLtp: number | null = null;
    let undLtp: number | null = null;
    let undSource: 'SPOT' | 'SYNTHETIC' = 'SPOT';
    if (und) {
      nextRequired.add(keyOf(und)); // spot is still needed to locate ATM
      spotLtp = this.ticks.get(keyOf(und))?.lp ?? null;
      undLtp = spotLtp;

      // NSE / BSE index underlying: use synthetic future instead of spot
      if (
        (und.exchange === 'NSE' || und.exchange === 'BSE') &&
        spotLtp != null
      ) {
        const syn = this.syntheticUnderlying(fullChain, spotLtp, nextRequired);
        if (syn != null) {
          undLtp = syn;
          undSource = 'SYNTHETIC';
        } // else: stays on spot until both ATM legs have ticks
      }
    }

    const n = cfg.strikesAroundAtm ?? 0; // 0 or missing = all strikes (old behaviour)
    const chain =
      n > 0 ? this.pickStrikeWindow(fullChain, undLtp, n) : fullChain;
    chain.forEach((r) => nextRequired.add(keyOf(r)));

    let callOi = 0,
      putOi = 0,
      received = 0;
    for (const r of chain) {
      const t = this.ticks.get(keyOf(r));
      if (!t) continue; // no tick at all yet
      received++;
      const oi = t.oi ?? 0;
      if (r.optType === 'CE') callOi += oi;
      else if (r.optType === 'PE') putOi += oi;
    }
    const pcr = callOi > 0 ? Number((putOi / callOi).toFixed(4)) : null;

    // --- lots ---
    // const lots = computeLots(
    //   pcr,
    //   cfg.pcrStartLevel ?? 1,
    //   cfg.pcrStep ?? 0.1,
    //   cfg.lotsPerTrade,
    // );

    const bull = cfg.pcrBullishStartLevel ?? 1.2; // ?? covers old Mongo docs
    const bear = cfg.pcrBearishStartLevel ?? 0.8;
    const lots = computeLots(
      pcr,
      bear,
      bull,
      cfg.pcrStep ?? 0.1,
      cfg.lotsPerTrade,
    );
    // --- contract to trade + matching open positions ---
    const universe = await this.getTradeUniverse(cfg);
    const openPositions = this.mapPositions(universe, pos.rows).filter(
      (p) => p.netQty !== 0,
    );
    const pick = this.pickContract(cfg, pcr, undLtp, universe, openPositions);

    openPositions.forEach((p) => nextRequired.add(keyOf(p)));
    if (pick.contract) nextRequired.add(keyOf(pick.contract));

    // to get option total postions
    // const dirSign = cfg.side === 'BUY' ? 1 : -1;
    // to get option total postions
    const isOpt = cfg.tradeInstrumentType.startsWith('OPT');
    // options: config side. futures: PCR decides
    const dirSign = isOpt
      ? cfg.side === 'BUY'
        ? 1
        : -1
      : pcr != null && pcr >= 1
        ? 1
        : -1;
    const totalOpenLots = openPositions
      .filter(
        (p) =>
          Math.sign(p.netQty) === dirSign &&
          (pick.optType
            ? p.optType === pick.optType
            : pick.contract
              ? keyOf(p) === keyOf(pick.contract)
              : true),
      )
      .reduce((s, p) => s + Math.abs(p.netLots), 0);

    return {
      configId: String(cfg.id),
      contractName: cfg.contractName,
      pcrExchange: cfg.pcrExchange,
      pcrExpiry: cfg.pcrExpiry,
      strategyActive: cfg.status === 'ACTIVE',
      // side: cfg.side,
      side: isOpt ? cfg.side : pcr != null && pcr >= 1 ? 'BUY' : 'SELL',
      timeframeMinutes: cfg.timeframeMinutes,
      // underlying: und ? { ...und, ltp: undLtp } : null,
      underlying: und
        ? { ...und, ltp: undLtp, spotLtp, source: undSource }
        : null,
      totalCallOi: callOi,
      totalPutOi: putOi,
      pcr,
      // pcrStartLevel: cfg.pcrStartLevel ?? 1,
      // in the returned object, replace pcrStartLevel with:
      pcrBullishStartLevel: bull,
      pcrBearishStartLevel: bear,
      pcrStep: cfg.pcrStep ?? 0.1,
      lots,
      optionType: pick.optType,
      contractToTrade: pick.contract,
      contractReason: pick.reason,
      openPositions,
      totalOpenLots,
      positionsOk: pos.ok,
      feed: {
        totalStrikes: chain.length,
        received,
        coverage: chain.length
          ? Number((received / chain.length).toFixed(3))
          : 0,
      },
      lastExecution: this.lastExecution.get(String(cfg.id)) ?? null,
      updatedAt: new Date().toISOString(),
    };
  }

  private pickContract(
    cfg: PcrStrategyConfigEntity,
    pcr: number | null,
    undLtp: number | null,
    universe: PcrInstrument[],
    open: PcrPosition[],
  ): {
    contract: PcrInstrument | null;
    optType: 'CE' | 'PE' | null;
    reason: string | null;
  } {
    if (cfg.tradeInstrumentType.startsWith('FUT')) {
      const c = universe[0] ?? null;
      return {
        contract: c,
        optType: null,
        reason: c ? null : 'Future not found in instrument file',
      };
    }
    if (pcr == null)
      return { contract: null, optType: null, reason: 'PCR not available yet' };

    // const optType = pcr >= 1 ? 'CE' : 'PE';
    const isBuy = cfg.side === 'BUY';
    // BUY : pcr>=1 → CE, else PE   |   SELL: pcr>=1 → PE, else CE
    const optType = pcr >= 1 === isBuy ? 'CE' : 'PE';

    // sticky strike: if a position already exists on this option side, keep trading that strike
    // const held = open.find((p) => p.optType === optType);
    // if (held) {
    //   const row = universe.find((u) => keyOf(u) === keyOf(held));
    //   if (row) return { contract: row, optType, reason: null };
    // }
    if (undLtp == null)
      return {
        contract: null,
        optType,
        reason: 'Underlying LTP not available yet',
      };

    const row = this.instruments.pickNearestStrike(universe, optType, undLtp);
    return {
      contract: row,
      optType,
      reason: row ? null : 'No option contract for trade expiry',
    };
  }

  /* ---------- JSON files ---------- */

  snapshotPath(cfg: { contractName: string; pcrExpiry: string }) {
    return path.join(
      this.DATA_DIR,
      `${cfg.contractName}_${cfg.pcrExpiry}.json`,
    );
  }

  private async writeSnapshot(cfg: PcrStrategyConfigEntity, snap: PcrSnapshot) {
    await fs.ensureDir(this.DATA_DIR);
    const file = this.snapshotPath(cfg);
    const tmp = `${file}.tmp`;
    await fs.writeJson(tmp, snap, { spaces: 2 });
    await fs.move(tmp, file, { overwrite: true }); // atomic: readers never see half a file
  }

  async readSnapshot(cfg: {
    contractName: string;
    pcrExpiry: string;
  }): Promise<PcrSnapshot | null> {
    const file = this.snapshotPath(cfg);
    return (await fs.pathExists(file)) ? fs.readJson(file) : null;
  }

  async readAllSnapshots(): Promise<PcrSnapshot[]> {
    await fs.ensureDir(this.DATA_DIR);
    const files = (await fs.readdir(this.DATA_DIR)).filter((f) =>
      f.endsWith('.json'),
    );
    return Promise.all(
      files.map((f) => fs.readJson(path.join(this.DATA_DIR, f))),
    );
  }

  /** Delete snapshot files that don't belong to any saved config. */
  private async pruneOrphanSnapshots(configs: PcrStrategyConfigEntity[]) {
    await fs.ensureDir(this.DATA_DIR);
    const keep = new Set(
      configs.map((c) => path.basename(this.snapshotPath(c))),
    );
    for (const f of await fs.readdir(this.DATA_DIR)) {
      if (!f.endsWith('.json') || keep.has(f)) continue;
      await fs.remove(path.join(this.DATA_DIR, f));
      this.logger.log(`Removed orphan PCR snapshot: ${f}`);
    }
  }

  // finding strikes around atm
  /** N strikes below + ATM + N strikes above, for both CE and PE */
  private pickStrikeWindow(
    chain: PcrInstrument[],
    ltp: number | null,
    n: number,
  ): PcrInstrument[] {
    if (ltp == null) return []; // underlying not ticking yet
    const strikes = [
      ...new Set(
        chain
          .map((r) => Number(r.strikePrice))
          .filter((s) => Number.isFinite(s)),
      ),
    ].sort((a, b) => a - b);
    if (!strikes.length) return [];

    let atm = 0;
    let best = Infinity;
    strikes.forEach((s, i) => {
      const d = Math.abs(s - ltp);
      if (d < best) {
        best = d;
        atm = i;
      }
    });
    const keep = new Set(strikes.slice(Math.max(0, atm - n), atm + n + 1));
    return chain.filter((r) => keep.has(Number(r.strikePrice)));
  }

  /** Synthetic future = K + CE - PE at the strike nearest to spot (put-call parity). */
  private syntheticUnderlying(
    chain: PcrInstrument[],
    spot: number,
    nextRequired: Set<string>,
  ): number | null {
    const byStrike = new Map<
      number,
      { ce?: PcrInstrument; pe?: PcrInstrument }
    >();
    for (const r of chain) {
      const k = Number(r.strikePrice);
      if (!Number.isFinite(k)) continue;
      const e = byStrike.get(k) ?? {};
      if (r.optType === 'CE') e.ce = r;
      else if (r.optType === 'PE') e.pe = r;
      byStrike.set(k, e);
    }

    let best: { k: number; ce: PcrInstrument; pe: PcrInstrument } | null = null;
    let bestDiff = Infinity;
    for (const [k, v] of byStrike) {
      if (!v.ce || !v.pe) continue; // need both legs at the same strike
      const d = Math.abs(k - spot);
      if (d < bestDiff) {
        bestDiff = d;
        best = { k, ce: v.ce, pe: v.pe };
      }
    }
    if (!best) return null;

    // always subscribe to both ATM legs, even if the strike window doesn't include them yet
    nextRequired.add(keyOf(best.ce));
    nextRequired.add(keyOf(best.pe));

    const c = this.ticks.get(keyOf(best.ce))?.lp;
    const p = this.ticks.get(keyOf(best.pe))?.lp;
    if (!(c && c > 0) || !(p && p > 0)) return null; // no live price on a leg yet

    return Number((best.k + c - p).toFixed(2));
  }
}
