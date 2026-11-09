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
  underlying: { exchange: string; token: string; ltp: number | null } | null;
  totalCallOi: number;
  totalPutOi: number;
  pcr: number | null;
  pcrStartLevel: number;
  pcrStep: number;
  lots: {
    direction: 'ABOVE' | 'BELOW' | 'AT' | 'NA';
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
  lastExecution: any;
  updatedAt: string;
}
