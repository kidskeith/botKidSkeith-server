import { config } from '../config/index.js';
import { generateSignature, generateNonce } from '../utils/helpers.js';

// ============== Types ==============

export interface IndodaxTicker {
  high: string;
  low: string;
  vol_base?: string;
  vol_idr?: string;
  last: string;
  buy: string;
  sell: string;
  server_time: number;
  name: string;
}

export interface IndodaxSummaries {
  tickers: Record<string, IndodaxTicker>;
  prices_24h: Record<string, string>;
  prices_7d: Record<string, string>;
}

export interface IndodaxPair {
  id: string;
  symbol: string;
  base_currency: string;
  traded_currency: string;
  traded_currency_unit: string;
  description: string;
  ticker_id: string;
  volume_precision: number;
  price_precision: number;
  trade_min_base_currency: number;
  trade_min_traded_currency: number;
  has_memo: boolean;
  url_logo: string;
  url_logo_png: string;
}

export interface IndodaxOHLC {
  Time: number;
  Open: number;
  High: number;
  Low: number;
  Close: number;
  Volume: string;
}

export interface IndodaxBalance {
  [currency: string]: string | number;
}

export interface IndodaxUserInfo {
  server_time: number;
  balance: IndodaxBalance;
  balance_hold: IndodaxBalance;
  address: Record<string, string>;
  user_id: string;
  name: string;
  email: string;
  verification_status: string;
}

export interface IndodaxTradeResult {
  receive_btc?: string;
  receive_idr?: string;
  spend_rp?: number;
  spend_btc?: string;
  fee: number;
  remain_rp?: number;
  remain_btc?: string;
  order_id: number;
  client_order_id?: string;
}

export interface IndodaxOrder {
  order_id: string;
  client_order_id?: string;
  submit_time: string;
  price: string;
  type: 'buy' | 'sell';
  order_type: string;
  order_btc?: string;
  order_idr?: string;
  remain_btc?: string;
  remain_idr?: string;
}

// ============== Public API ==============

export class IndodaxPublicAPI {
  private baseUrl = config.indodax.publicApiUrl;
  
  async getServerTime(): Promise<{ timezone: string; server_time: number }> {
    const response = await fetch(`${this.baseUrl}/server_time`);
    if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
    return response.json() as Promise<{ timezone: string; server_time: number }>;
  }
  
  async getPairs(): Promise<IndodaxPair[]> {
    const response = await fetch(`${this.baseUrl}/pairs`);
    if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
    return response.json() as Promise<IndodaxPair[]>;
  }
  
  async getSummaries(): Promise<IndodaxSummaries> {
    const response = await fetch(`${this.baseUrl}/summaries`);
    if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
    return response.json() as Promise<IndodaxSummaries>;
  }
  
  async getTicker(pair: string): Promise<{ ticker: IndodaxTicker }> {
    const response = await fetch(`${this.baseUrl}/ticker/${pair}`);
    if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
    return response.json() as Promise<{ ticker: IndodaxTicker }>;
  }
  
  async getDepth(pair: string): Promise<{ buy: [number, string][]; sell: [number, string][] }> {
    const response = await fetch(`${this.baseUrl}/depth/${pair}`);
    if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
    return response.json() as Promise<{ buy: [number, string][]; sell: [number, string][] }>;
  }
  
  async getTrades(pair: string): Promise<{ date: string; price: string; amount: string; tid: string; type: string }[]> {
    const response = await fetch(`${this.baseUrl}/trades/${pair}`);
    if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
    return response.json() as Promise<{ date: string; price: string; amount: string; tid: string; type: string }[]>;
  }
  
  async getOHLC(pair: string, timeframe: string, from: number, to: number): Promise<IndodaxOHLC[]> {
    // Indodax TradingView API expects symbol WITHOUT underscore (e.g., BTCIDR not BTC_IDR)
    const symbol = pair.replace('_', '').toUpperCase();
    const url = `https://indodax.com/tradingview/history_v2?symbol=${symbol}&tf=${timeframe}&from=${from}&to=${to}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
    return response.json() as Promise<IndodaxOHLC[]>;
  }
}

// ============== Private API ==============

export class IndodaxPrivateAPI {
  private baseUrl = config.indodax.privateApiUrl;
  private apiKey: string;
  private secretKey: string;
  
  constructor(apiKey: string, secretKey: string) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
  }
  
  private async request<T>(method: string, params: Record<string, string | number> = {}): Promise<T> {
    const nonce = generateNonce();
    const body = new URLSearchParams({
      method,
      nonce: nonce.toString(),
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)])
      ),
    }).toString();
    
    const signature = generateSignature(this.secretKey, body);
    
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Key': this.apiKey,
        'Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    
    const data = await response.json() as { success: number; return?: T; error?: string; error_code?: string };
    
    if (data.success !== 1) {
      throw new Error(data.error || 'Unknown API error');
    }
    
    return data.return as T;
  }
  
  // Get user info & balances
  async getInfo(): Promise<IndodaxUserInfo> {
    return this.request<IndodaxUserInfo>('getInfo');
  }
  
  // Place a trade order
  async trade(params: {
    pair: string;
    type: 'buy' | 'sell';
    price: number;
    amount?: number;     // Coin amount (for sell or limit buy)
    idr?: number;        // IDR amount (for market buy)
    orderType?: 'limit' | 'market';
    clientOrderId?: string;
  }): Promise<IndodaxTradeResult> {
    const { pair, type, price, amount, idr, orderType = 'limit', clientOrderId } = params;
    
    const requestParams: Record<string, string | number> = {
      pair,
      type,
      price,
      order_type: orderType,
    };
    
    if (clientOrderId) {
      requestParams.client_order_id = clientOrderId;
    }
    
    // For sell orders, always use coin amount
    if (type === 'sell' && amount) {
      const [base] = pair.split('_');
      requestParams[base] = amount;
    }
    
    // For buy orders
    if (type === 'buy') {
      if (orderType === 'market' && idr) {
        requestParams.idr = idr;
      } else if (amount) {
        const [base] = pair.split('_');
        requestParams[base] = amount;
      } else if (idr) {
        requestParams.idr = idr;
      }
    }
    
    return this.request<IndodaxTradeResult>('trade', requestParams);
  }
  
  // Get open orders
  async getOpenOrders(pair?: string): Promise<{ orders: IndodaxOrder[] }> {
    const params: Record<string, string> = {};
    if (pair) params.pair = pair;
    return this.request<{ orders: IndodaxOrder[] }>('openOrders', params);
  }
  
  // Get order history
  async getOrderHistory(pair: string, count: number = 100): Promise<{ orders: IndodaxOrder[] }> {
    return this.request<{ orders: IndodaxOrder[] }>('orderHistory', { pair, count });
  }
  
  // Get specific order
  async getOrder(pair: string, orderId: number): Promise<{ order: IndodaxOrder }> {
    return this.request<{ order: IndodaxOrder }>('getOrder', { pair, order_id: orderId });
  }
  
  // Cancel order
  async cancelOrder(pair: string, orderId: number, type: 'buy' | 'sell'): Promise<{ order_id: number; type: string; pair: string }> {
    return this.request<{ order_id: number; type: string; pair: string }>('cancelOrder', {
      pair,
      order_id: orderId,
      type,
    });
  }
  
  // Get trade history
  async getTradeHistory(pair: string, count: number = 100): Promise<{ trades: any[] }> {
    return this.request<{ trades: any[] }>('tradeHistory', { pair, count });
  }
}

// ============== Exports ==============

export const indodaxPublicAPI = new IndodaxPublicAPI();
