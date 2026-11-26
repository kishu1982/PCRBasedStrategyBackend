//Shared types (PcrInstrument, PcrPosition, PcrSnapshot)

export interface PcrInstrument {
  exchange: string;
  token: string;
  symbol: string;
  tradingSymbol: string;
  expiry: string;
  instrument: string;
  optType: 'CE' | 'PE' | null;
  strikePrice: number | null;
  lotSize: number | null;
}

export interface PcrPosition {
  exchange: string;
  token: string;
  tradingSymbol: string;
  optType: 'CE' | 'PE' | null;
  lotSize: number;
  netQty: number;
  netLots: number;
  avgPrice: number;
  ltp: number;
  pnl: number;
}

export interface PcrSnapshot {
  configId: string;
  contractName: string;
  pcrExchange: string;
  pcrExpiry: string;
  strategyActive: boolean;
  side: string;
  timeframeMinutes: number;
  underlying: {
    exchange: string;
    token: string;
    ltp: number | null;
    spotLtp?: number | null;
    source?: 'SPOT' | 'SYNTHETIC';
  } | null;
  totalCallOi: number;
  totalPutOi: number;
  pcr: number | null;
  // pcrStartLevel: number;
  pcrBullishStartLevel: number;
  pcrBearishStartLevel: number;
  // pcrStep: number;
  pcrBullishStep: number;
  pcrBearishStep: number;
  lots: {
    direction: 'ABOVE' | 'BELOW' | 'NEUTRAL' | 'NA';
    pcrLots: number;
    lotsPerTrade: number;
    targetLots: number;
  };
  optionType: 'CE' | 'PE' | null;
  contractToTrade: PcrInstrument | null;
  contractReason: string | null;
  openPositions: PcrPosition[];
  totalOpenLots: number;
  positionsOk: boolean;
  feed: { totalStrikes: number; received: number; coverage: number };
  pcrStrikes: {
    strikesAroundAtm: number; // 0 = all strikes
    atmStrike: number | null;
    callCount: number;
    putCount: number;
    strikes: PcrStrikeUsed[];
  };
  lastExecution: any;
  updatedAt: string;
}

export interface PcrStrikeUsed {
  strike: number;
  ce: { tradingSymbol: string; token: string; oi: number | null } | null;
  pe: { tradingSymbol: string; token: string; oi: number | null } | null;
}
