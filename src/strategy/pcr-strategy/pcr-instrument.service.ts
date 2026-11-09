import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PcrInstrument } from './pcr-strategy.types';

/*
Reads instruments.json (cached). It finds the option chain, the future, the nearest strike and the expiries
*/

const MONTHS: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};
export function parseExpiry(e: string): number {
  const [d, m, y] = e.toUpperCase().split('-');
  return Date.UTC(Number(y), MONTHS[m], Number(d));
}

@Injectable()
export class PcrInstrumentService {
  private readonly logger = new Logger(PcrInstrumentService.name);
  private readonly FILE = path.join(
    process.cwd(),
    'data',
    'instrumentInfo',
    'instruments.json',
  );
  private rows: PcrInstrument[] = [];
  private mtime = 0;
  private loading: Promise<void> | null = null;
  private readonly queryCache = new Map<string, PcrInstrument[]>();

  private async ensureLoaded() {
    if (!(await fs.pathExists(this.FILE))) {
      throw new Error(
        'Instrument file missing. Call the instrument refresh API first.',
      );
    }
    const { mtimeMs } = await fs.stat(this.FILE);
    if (mtimeMs === this.mtime) return;
    if (!this.loading) {
      this.loading = (async () => {
        const raw: any[] = await fs.readJson(this.FILE);
        this.rows = raw
          .filter((r) =>
            /^(FUT|OPT)/.test(String(r.instrument || '').toUpperCase()),
          )
          .map((r) => this.slim(r));
        this.mtime = mtimeMs;
        this.queryCache.clear();
        this.logger.log(`Loaded ${this.rows.length} derivative instruments`);
      })().finally(() => (this.loading = null));
    }
    await this.loading;
  }

  private optType(v: any, tsym: string): 'CE' | 'PE' | null {
    const t = String(v || '').toUpperCase();
    if (t.startsWith('C')) return 'CE';
    if (t.startsWith('P')) return 'PE';
    const s = tsym.toUpperCase();
    if (/CE$/.test(s) || /C\d+(\.\d+)?$/.test(s)) return 'CE';
    if (/PE$/.test(s) || /P\d+(\.\d+)?$/.test(s)) return 'PE';
    return null;
  }

  private slim(r: any): PcrInstrument {
    const tsym = String(r.tradingSymbol || '');
    return {
      exchange: String(r.exchange || '').toUpperCase(),
      token: String(r.token),
      symbol: String(r.symbol || '').toUpperCase(),
      tradingSymbol: tsym,
      expiry: String(r.expiry || '').toUpperCase(),
      instrument: String(r.instrument).toUpperCase(),
      optType: this.optType(r.optionType, tsym),
      strikePrice: r.strikePrice ?? null,
      lotSize: r.lotSize ?? null,
    };
  }

  /** exact match on exchange + symbol + instrument (+ expiry) */
  async find(q: {
    exchange: string;
    symbol: string;
    instrument: string;
    expiry?: string;
  }) {
    await this.ensureLoaded();
    const key = [q.exchange, q.symbol, q.instrument, q.expiry ?? '']
      .join('|')
      .toUpperCase();
    let hit = this.queryCache.get(key);
    if (!hit) {
      const [E, S, I] = [q.exchange, q.symbol, q.instrument].map((x) =>
        x.toUpperCase(),
      );
      const X = q.expiry?.toUpperCase();
      hit = this.rows.filter(
        (r) =>
          r.exchange === E &&
          r.symbol === S &&
          r.instrument === I &&
          (!X || r.expiry === X),
      );
      this.queryCache.set(key, hit);
    }
    return hit;
  }

  async findNearestFuture(
    exchange: string,
    symbol: string,
  ): Promise<PcrInstrument | null> {
    await this.ensureLoaded();
    const now = new Date();
    const today = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const E = exchange.toUpperCase();
    const S = symbol.toUpperCase();
    const futs = this.rows
      .filter(
        (r) =>
          r.exchange === E &&
          r.symbol === S &&
          r.instrument.startsWith('FUT') &&
          parseExpiry(r.expiry) >= today,
      )
      .sort((a, b) => parseExpiry(a.expiry) - parseExpiry(b.expiry));
    return futs[0] ?? null;
  }

  pickNearestStrike(chain: PcrInstrument[], optType: 'CE' | 'PE', ltp: number) {
    let best: PcrInstrument | null = null;
    let bestDiff = Infinity;
    for (const r of chain) {
      if (r.optType !== optType || r.strikePrice == null) continue;
      const d = Math.abs(r.strikePrice - ltp);
      if (d < bestDiff) {
        best = r;
        bestDiff = d;
      }
    }
    return best;
  }
}
