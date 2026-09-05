/** NIFTY 50 constituents with sector assignments. NSE tickers, Yahoo suffix `.NS`. */

export interface SymbolDef {
  ticker: string
  name: string
  sectorId: string
}

export interface SectorDef {
  id: string
  name: string
  /** NSE sector index where one exists, for future benchmark refinement. */
  indexTicker: string | null
}

export const BENCHMARK = { ticker: '^NSEI', name: 'NIFTY 50' } as const

export const SECTORS: SectorDef[] = [
  { id: 'FIN', name: 'Financial Services', indexTicker: '^NSEBANK' },
  { id: 'IT', name: 'Information Technology', indexTicker: null },
  { id: 'ENERGY', name: 'Oil, Gas & Energy', indexTicker: null },
  { id: 'FMCG', name: 'Consumer Goods', indexTicker: null },
  { id: 'AUTO', name: 'Automobile', indexTicker: null },
  { id: 'PHARMA', name: 'Healthcare & Pharma', indexTicker: null },
  { id: 'METAL', name: 'Metals & Mining', indexTicker: null },
  { id: 'INFRA', name: 'Construction & Infrastructure', indexTicker: null },
  { id: 'TELECOM', name: 'Telecom', indexTicker: null },
  { id: 'POWER', name: 'Power & Utilities', indexTicker: null },
]

export const UNIVERSE: SymbolDef[] = [
  { ticker: 'HDFCBANK', name: 'HDFC Bank', sectorId: 'FIN' },
  { ticker: 'ICICIBANK', name: 'ICICI Bank', sectorId: 'FIN' },
  { ticker: 'SBIN', name: 'State Bank of India', sectorId: 'FIN' },
  { ticker: 'KOTAKBANK', name: 'Kotak Mahindra Bank', sectorId: 'FIN' },
  { ticker: 'AXISBANK', name: 'Axis Bank', sectorId: 'FIN' },
  { ticker: 'BAJFINANCE', name: 'Bajaj Finance', sectorId: 'FIN' },
  { ticker: 'BAJAJFINSV', name: 'Bajaj Finserv', sectorId: 'FIN' },
  { ticker: 'INDUSINDBK', name: 'IndusInd Bank', sectorId: 'FIN' },
  { ticker: 'SBILIFE', name: 'SBI Life Insurance', sectorId: 'FIN' },
  { ticker: 'HDFCLIFE', name: 'HDFC Life Insurance', sectorId: 'FIN' },
  { ticker: 'TCS', name: 'Tata Consultancy Services', sectorId: 'IT' },
  { ticker: 'INFY', name: 'Infosys', sectorId: 'IT' },
  { ticker: 'HCLTECH', name: 'HCL Technologies', sectorId: 'IT' },
  { ticker: 'WIPRO', name: 'Wipro', sectorId: 'IT' },
  { ticker: 'TECHM', name: 'Tech Mahindra', sectorId: 'IT' },
  { ticker: 'LTIM', name: 'LTIMindtree', sectorId: 'IT' },
  { ticker: 'RELIANCE', name: 'Reliance Industries', sectorId: 'ENERGY' },
  { ticker: 'ONGC', name: 'Oil & Natural Gas Corp', sectorId: 'ENERGY' },
  { ticker: 'BPCL', name: 'Bharat Petroleum', sectorId: 'ENERGY' },
  { ticker: 'COALINDIA', name: 'Coal India', sectorId: 'ENERGY' },
  { ticker: 'HINDUNILVR', name: 'Hindustan Unilever', sectorId: 'FMCG' },
  { ticker: 'ITC', name: 'ITC', sectorId: 'FMCG' },
  { ticker: 'NESTLEIND', name: 'Nestle India', sectorId: 'FMCG' },
  { ticker: 'BRITANNIA', name: 'Britannia Industries', sectorId: 'FMCG' },
  { ticker: 'TATACONSUM', name: 'Tata Consumer Products', sectorId: 'FMCG' },
  { ticker: 'MARUTI', name: 'Maruti Suzuki', sectorId: 'AUTO' },
  { ticker: 'M&M', name: 'Mahindra & Mahindra', sectorId: 'AUTO' },
  { ticker: 'TATAMOTORS', name: 'Tata Motors', sectorId: 'AUTO' },
  { ticker: 'EICHERMOT', name: 'Eicher Motors', sectorId: 'AUTO' },
  { ticker: 'HEROMOTOCO', name: 'Hero MotoCorp', sectorId: 'AUTO' },
  { ticker: 'BAJAJ-AUTO', name: 'Bajaj Auto', sectorId: 'AUTO' },
  { ticker: 'SUNPHARMA', name: 'Sun Pharmaceutical', sectorId: 'PHARMA' },
  { ticker: 'DRREDDY', name: "Dr. Reddy's Laboratories", sectorId: 'PHARMA' },
  { ticker: 'CIPLA', name: 'Cipla', sectorId: 'PHARMA' },
  { ticker: 'DIVISLAB', name: "Divi's Laboratories", sectorId: 'PHARMA' },
  { ticker: 'APOLLOHOSP', name: 'Apollo Hospitals', sectorId: 'PHARMA' },
  { ticker: 'TATASTEEL', name: 'Tata Steel', sectorId: 'METAL' },
  { ticker: 'JSWSTEEL', name: 'JSW Steel', sectorId: 'METAL' },
  { ticker: 'HINDALCO', name: 'Hindalco Industries', sectorId: 'METAL' },
  { ticker: 'LT', name: 'Larsen & Toubro', sectorId: 'INFRA' },
  { ticker: 'ULTRACEMCO', name: 'UltraTech Cement', sectorId: 'INFRA' },
  { ticker: 'GRASIM', name: 'Grasim Industries', sectorId: 'INFRA' },
  { ticker: 'ADANIPORTS', name: 'Adani Ports & SEZ', sectorId: 'INFRA' },
  { ticker: 'ADANIENT', name: 'Adani Enterprises', sectorId: 'INFRA' },
  { ticker: 'ASIANPAINT', name: 'Asian Paints', sectorId: 'INFRA' },
  { ticker: 'TITAN', name: 'Titan Company', sectorId: 'FMCG' },
  { ticker: 'BHARTIARTL', name: 'Bharti Airtel', sectorId: 'TELECOM' },
  { ticker: 'NTPC', name: 'NTPC', sectorId: 'POWER' },
  { ticker: 'POWERGRID', name: 'Power Grid Corporation', sectorId: 'POWER' },
  { ticker: 'UPL', name: 'UPL', sectorId: 'INFRA' },
]

export const symbolId = (ticker: string) => `${ticker}.NS`
export const BENCHMARK_ID = BENCHMARK.ticker


/* ------------------------------------------------------------- US universe */

/**
 * A US universe, used ONLY to validate the scoring model against real market
 * data.
 *
 * The product is built for NSE and the demo stays there. But free NSE feeds are
 * gated behind paid plans, and a model validated only against data I generated
 * proves nothing about markets. Twelve Data's free tier serves real US equities,
 * so the evaluation runs on those: the claim becomes "this ranking beats
 * percentage change on real market data" rather than "on my own simulation".
 *
 * Sectors mirror the NSE mapping so the same grouping logic applies unchanged.
 */
export const US_BENCHMARK = { ticker: 'SPY', name: 'S&P 500 ETF' } as const

export const US_UNIVERSE: SymbolDef[] = [
  { ticker: 'JPM', name: 'JPMorgan Chase', sectorId: 'FIN' },
  { ticker: 'BAC', name: 'Bank of America', sectorId: 'FIN' },
  { ticker: 'WFC', name: 'Wells Fargo', sectorId: 'FIN' },
  { ticker: 'GS', name: 'Goldman Sachs', sectorId: 'FIN' },
  { ticker: 'MS', name: 'Morgan Stanley', sectorId: 'FIN' },
  { ticker: 'C', name: 'Citigroup', sectorId: 'FIN' },
  { ticker: 'AXP', name: 'American Express', sectorId: 'FIN' },
  { ticker: 'BLK', name: 'BlackRock', sectorId: 'FIN' },
  { ticker: 'AAPL', name: 'Apple', sectorId: 'IT' },
  { ticker: 'MSFT', name: 'Microsoft', sectorId: 'IT' },
  { ticker: 'NVDA', name: 'NVIDIA', sectorId: 'IT' },
  { ticker: 'AVGO', name: 'Broadcom', sectorId: 'IT' },
  { ticker: 'ORCL', name: 'Oracle', sectorId: 'IT' },
  { ticker: 'CRM', name: 'Salesforce', sectorId: 'IT' },
  { ticker: 'ADBE', name: 'Adobe', sectorId: 'IT' },
  { ticker: 'AMD', name: 'Advanced Micro Devices', sectorId: 'IT' },
  { ticker: 'INTC', name: 'Intel', sectorId: 'IT' },
  { ticker: 'CSCO', name: 'Cisco Systems', sectorId: 'IT' },
  { ticker: 'XOM', name: 'Exxon Mobil', sectorId: 'ENERGY' },
  { ticker: 'CVX', name: 'Chevron', sectorId: 'ENERGY' },
  { ticker: 'COP', name: 'ConocoPhillips', sectorId: 'ENERGY' },
  { ticker: 'SLB', name: 'Schlumberger', sectorId: 'ENERGY' },
  { ticker: 'PG', name: 'Procter & Gamble', sectorId: 'FMCG' },
  { ticker: 'KO', name: 'Coca-Cola', sectorId: 'FMCG' },
  { ticker: 'PEP', name: 'PepsiCo', sectorId: 'FMCG' },
  { ticker: 'COST', name: 'Costco', sectorId: 'FMCG' },
  { ticker: 'WMT', name: 'Walmart', sectorId: 'FMCG' },
  { ticker: 'MCD', name: "McDonald's", sectorId: 'FMCG' },
  { ticker: 'TSLA', name: 'Tesla', sectorId: 'AUTO' },
  { ticker: 'F', name: 'Ford Motor', sectorId: 'AUTO' },
  { ticker: 'GM', name: 'General Motors', sectorId: 'AUTO' },
  { ticker: 'JNJ', name: 'Johnson & Johnson', sectorId: 'PHARMA' },
  { ticker: 'PFE', name: 'Pfizer', sectorId: 'PHARMA' },
  { ticker: 'MRK', name: 'Merck', sectorId: 'PHARMA' },
  { ticker: 'ABBV', name: 'AbbVie', sectorId: 'PHARMA' },
  { ticker: 'LLY', name: 'Eli Lilly', sectorId: 'PHARMA' },
  { ticker: 'UNH', name: 'UnitedHealth', sectorId: 'PHARMA' },
  { ticker: 'NEM', name: 'Newmont', sectorId: 'METAL' },
  { ticker: 'FCX', name: 'Freeport-McMoRan', sectorId: 'METAL' },
  { ticker: 'NUE', name: 'Nucor', sectorId: 'METAL' },
  { ticker: 'CAT', name: 'Caterpillar', sectorId: 'INFRA' },
  { ticker: 'DE', name: 'Deere', sectorId: 'INFRA' },
  { ticker: 'HON', name: 'Honeywell', sectorId: 'INFRA' },
  { ticker: 'GE', name: 'General Electric', sectorId: 'INFRA' },
  { ticker: 'BA', name: 'Boeing', sectorId: 'INFRA' },
  { ticker: 'T', name: 'AT&T', sectorId: 'TELECOM' },
  { ticker: 'VZ', name: 'Verizon', sectorId: 'TELECOM' },
  { ticker: 'TMUS', name: 'T-Mobile US', sectorId: 'TELECOM' },
  { ticker: 'NEE', name: 'NextEra Energy', sectorId: 'POWER' },
  { ticker: 'DUK', name: 'Duke Energy', sectorId: 'POWER' },
  { ticker: 'SO', name: 'Southern Company', sectorId: 'POWER' },
]

export type UniverseName = 'nifty50' | 'us'

export function universeFor(name: UniverseName): {
  symbols: SymbolDef[]
  benchmarkId: string
  benchmarkName: string
  exchange: string
  suffix: string
} {
  if (name === 'us') {
    return {
      symbols: US_UNIVERSE, benchmarkId: US_BENCHMARK.ticker,
      benchmarkName: US_BENCHMARK.name, exchange: 'US', suffix: '',
    }
  }
  return {
    symbols: UNIVERSE, benchmarkId: BENCHMARK_ID,
    benchmarkName: BENCHMARK.name, exchange: 'NSE', suffix: '.NS',
  }
}
