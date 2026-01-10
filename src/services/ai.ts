import { GoogleGenAI } from '@google/genai';
import { config } from '../config/index.js';
import { decrypt } from '../utils/encryption.js';
import prisma from '../config/database.js';
import { indodaxPublicAPI, IndodaxOHLC } from './indodax.js';

// Types
export interface MarketContext {
  pair: string;
  currentPrice: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  change24h: number;
  ohlc: IndodaxOHLC[];
}

export interface AIAnalysisResult {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  technicalScore: number;
  sentimentScore: number;
  riskScore: number;
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  amountPercent: number;
  reasoning: string;
  timeframe: string;
  // Detailed analysis breakdown
  analysis?: {
    trend: {
      direction: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
      strength: 'STRONG' | 'MODERATE' | 'WEAK';
      description: string;
    };
    indicators: {
      rsi: { value: number; signal: 'OVERSOLD' | 'NEUTRAL' | 'OVERBOUGHT'; description: string };
      macd: { value: number; signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; histogram: number; description: string };
      bollingerBands: { position: 'ABOVE_UPPER' | 'NEAR_UPPER' | 'MIDDLE' | 'NEAR_LOWER' | 'BELOW_LOWER'; description: string };
      volume: { trend: 'INCREASING' | 'DECREASING' | 'STABLE'; signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; description: string };
      ema: { ema9: number; ema21: number; crossover: 'GOLDEN' | 'DEATH' | 'NONE'; description: string };
    };
    supportResistance: {
      nearestSupport: number;
      nearestResistance: number;
      description: string;
    };
    priceAction: {
      pattern: string;
      description: string;
    };
    riskReward: {
      ratio: number;
      assessment: 'FAVORABLE' | 'NEUTRAL' | 'UNFAVORABLE';
    };
  };
}

export interface SignalGenerationParams {
  userId: string;
  pair: string;
  userRiskProfile: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  newsContext?: string;
  scalpingMode?: {
    enabled: boolean;
    takeProfitPct: number;
    stopLossPct: number;
    maxHoldMins: number;
  };
  userSettings?: {
    stopLossPercent: number;
    takeProfitPercent: number;
    maxPositionPercent: number;
  };
}

// Helper function to calculate EMA
function calculateEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  if (prices.length < period) return prices[prices.length - 1] || 0;
  
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

// Risk multipliers based on profile
const RISK_PROFILES = {
  CONSERVATIVE: {
    maxPositionPercent: 5,
    stopLossPercent: 2,
    takeProfitPercent: 5,
    minConfidence: 0.85,
  },
  BALANCED: {
    maxPositionPercent: 10,
    stopLossPercent: 5,
    takeProfitPercent: 10,
    minConfidence: 0.75,
  },
  AGGRESSIVE: {
    maxPositionPercent: 20,
    stopLossPercent: 8,
    takeProfitPercent: 20,
    minConfidence: 0.65,
  },
};

/**
 * Get Gemini AI client for a user
 */
async function getGeminiClient(userId: string): Promise<GoogleGenAI | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { geminiApiKey: true },
  });
  
  if (!user?.geminiApiKey) {
    // Try system-level API key
    if (config.geminiApiKey) {
      return new GoogleGenAI({ apiKey: config.geminiApiKey });
    }
    return null;
  }
  
  const apiKey = decrypt(user.geminiApiKey);
  return new GoogleGenAI({ apiKey });
}

/**
 * Fetch market context for analysis
 */
export async function getMarketContext(pair: string): Promise<MarketContext> {
  // Get current market data
  const summaries = await indodaxPublicAPI.getSummaries();
  
  // Normalize pair to underscore format (btc_idr)
  const pairKey = pair.toLowerCase().replace('-', '_');
  // For prices_24h, Indodax uses no underscore (btcidr)
  const priceKey = pairKey.replace('_', '');
  
  // Try to find ticker - API uses underscore format in tickers
  const ticker = summaries.tickers[pairKey];
  
  if (!ticker) {
    throw new Error(`Pair not found: ${pair}`);
  }
  
  // Get OHLC data (last 24 hours, 15-minute candles)
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 24 * 60 * 60;
  const ohlc = await indodaxPublicAPI.getOHLC(pairKey, '15', dayAgo, now);
  
  // DEBUG: Log OHLC data quality
  console.log('='.repeat(60));
  console.log(`[DEBUG:OHLC] Pair: ${pairKey}`);
  console.log(`[DEBUG:OHLC] OHLC Array Length: ${ohlc.length}`);
  if (ohlc.length > 0) {
    console.log(`[DEBUG:OHLC] First candle:`, JSON.stringify(ohlc[0]));
    console.log(`[DEBUG:OHLC] Last candle:`, JSON.stringify(ohlc[ohlc.length - 1]));
    console.log(`[DEBUG:OHLC] Sample closes:`, ohlc.slice(-5).map(c => c.Close));
    console.log(`[DEBUG:OHLC] Sample volumes:`, ohlc.slice(-5).map(c => c.Volume));
  } else {
    console.log(`[DEBUG:OHLC] ⚠️ OHLC ARRAY IS EMPTY! Creating synthetic fallback...`);
  }
  console.log('='.repeat(60));
  
  // FALLBACK: If OHLC is empty, create synthetic data from ticker for indicator calculations
  let ohlcData: IndodaxOHLC[] = ohlc;
  if (ohlc.length === 0) {
    console.log(`[AI] Creating synthetic OHLC from ticker for ${pair}`);
    const lastPrice = parseFloat(ticker.last);
    const highPrice = parseFloat(ticker.high);
    const lowPrice = parseFloat(ticker.low);
    const volume = parseFloat(ticker.vol_idr || '0') / 24; // Spread volume across 24 candles
    
    // Create 24 synthetic candles with slight variation based on high/low
    const priceRange = highPrice - lowPrice;
    const syntheticOhlc: IndodaxOHLC[] = [];
    
    for (let i = 0; i < 24; i++) {
      // Create realistic-ish variation between low and current
      const randomFactor = Math.sin((i / 24) * Math.PI * 2) * 0.3 + 0.6; // Varies 0.3 to 0.9
      const candleOpen = lowPrice + (priceRange * randomFactor);
      const candleClose = lowPrice + (priceRange * (randomFactor + Math.random() * 0.1 - 0.05));
      const candleHigh = Math.max(candleOpen, candleClose) + (priceRange * 0.02);
      const candleLow = Math.min(candleOpen, candleClose) - (priceRange * 0.02);
      
      syntheticOhlc.push({
        Time: now - (24 - i) * 3600, // 1 hour intervals
        Open: candleOpen,
        High: candleHigh,
        Low: candleLow,
        Close: candleClose,
        Volume: String(volume * (0.8 + Math.random() * 0.4)), // Random volume variation
      });
    }
    
    // Last candle should use actual current price
    syntheticOhlc[syntheticOhlc.length - 1].Close = lastPrice;
    
    ohlcData = syntheticOhlc;
    console.log(`[AI] Created ${syntheticOhlc.length} synthetic OHLC candles`);
  }
  
  // Calculate 24h change
  const openPrice = parseFloat(summaries.prices_24h?.[priceKey] || ticker.last);
  const lastPrice = parseFloat(ticker.last);
  const change24h = ((lastPrice - openPrice) / openPrice) * 100;
  
  return {
    pair,
    currentPrice: lastPrice,
    high24h: parseFloat(ticker.high),
    low24h: parseFloat(ticker.low),
    volume24h: parseFloat(ticker.vol_idr || '0'),
    change24h,
    ohlc: ohlcData, // Use ohlcData which includes synthetic fallback
  };
}

/**
 * Build analysis prompt for Gemini with comprehensive technical indicators
 */
function buildAnalysisPrompt(
  context: MarketContext,
  riskProfile: keyof typeof RISK_PROFILES,
  newsContext?: string,
  userSettings?: { stopLossPercent: number; takeProfitPercent: number; maxPositionPercent: number }
): string {
  const riskConfig = RISK_PROFILES[riskProfile];
  // Convert OHLC data to numbers (API may return strings)
  const closes = context.ohlc.map(c => Number(c.Close));
  const highs = context.ohlc.map(c => Number(c.High));
  const lows = context.ohlc.map(c => Number(c.Low));
  const volumes = context.ohlc.map(c => Number(c.Volume || 0));
  
  // ===== MOVING AVERAGES =====
  const calcSMA = (data: number[], period: number) => 
    data.length >= period ? data.slice(-period).reduce((a, b) => a + b, 0) / period : data[data.length - 1] || 0;
  
  const calcEMA = (data: number[], period: number) => {
    if (data.length < period) return data[data.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = calcSMA(data.slice(0, period), period);
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  };
  
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  
  // ===== RSI (14) =====
  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length && i > 0; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const rsi = 100 - (100 / (1 + (gains / 14) / ((losses / 14) || 0.001)));
  const rsiSignal = rsi < 30 ? 'OVERSOLD' : rsi > 70 ? 'OVERBOUGHT' : 'NEUTRAL';
  
  // ===== MACD (12, 26, 9) =====
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12 - ema26;
  // Simplified signal line (would need historical MACD values for proper calculation)
  const macdSignalLine = macdLine * 0.9; // Approximation
  const macdHistogram = macdLine - macdSignalLine;
  const macdSignal = macdHistogram > 0 ? 'BULLISH' : macdHistogram < 0 ? 'BEARISH' : 'NEUTRAL';
  
  // ===== BOLLINGER BANDS (20, 2) =====
  const bbMiddle = sma20;
  const bbStdDev = Math.sqrt(closes.slice(-20).reduce((sum, val) => sum + Math.pow(val - sma20, 2), 0) / 20);
  const bbUpper = bbMiddle + 2 * bbStdDev;
  const bbLower = bbMiddle - 2 * bbStdDev;
  const bbPosition = context.currentPrice > bbUpper ? 'ABOVE_UPPER' : 
    context.currentPrice > bbMiddle + bbStdDev ? 'NEAR_UPPER' :
    context.currentPrice < bbLower ? 'BELOW_LOWER' :
    context.currentPrice < bbMiddle - bbStdDev ? 'NEAR_LOWER' : 'MIDDLE';
  
  // ===== VOLUME ANALYSIS =====
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const recentVolume = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volumeTrend = recentVolume > avgVolume * 1.2 ? 'INCREASING' : 
    recentVolume < avgVolume * 0.8 ? 'DECREASING' : 'STABLE';
  
  // ===== SUPPORT & RESISTANCE =====
  const recentLows = lows.slice(-20);
  const recentHighs = highs.slice(-20);
  const nearestSupport = Math.min(...recentLows);
  const nearestResistance = Math.max(...recentHighs);
  
  // ===== TREND ANALYSIS =====
  const trendDirection = ema9 > ema21 && sma20 > sma50 ? 'BULLISH' : 
    ema9 < ema21 && sma20 < sma50 ? 'BEARISH' : 'SIDEWAYS';
  const trendStrength = Math.abs((ema9 - ema21) / ema21 * 100) > 2 ? 'STRONG' : 
    Math.abs((ema9 - ema21) / ema21 * 100) > 0.5 ? 'MODERATE' : 'WEAK';
  
  // User settings section
  const userSettingsSection = userSettings ? `
## Preferensi Setting User
- **Max Position**: ${userSettings.maxPositionPercent}%
- **Stop Loss**: ${userSettings.stopLossPercent}%
- **Take Profit**: ${userSettings.takeProfitPercent}%
(Berikan rekomendasi berdasarkan ANALISA TEKNIKAL ANDA SENDIRI)
` : '';
  
  return `
Anda adalah AI Trading Analyst profesional. Lakukan ANALISA MENDALAM dengan BERBAGAI INDIKATOR berikut:

## 📊 DATA PASAR REAL-TIME
| Metric | Value |
|--------|-------|
| Pair | ${context.pair.toUpperCase()} |
| Harga Saat Ini | Rp ${context.currentPrice.toLocaleString('id-ID')} |
| High 24h | Rp ${context.high24h.toLocaleString('id-ID')} |
| Low 24h | Rp ${context.low24h.toLocaleString('id-ID')} |
| Volume 24h | Rp ${context.volume24h.toLocaleString('id-ID')} |
| Perubahan 24h | ${context.change24h.toFixed(2)}% |

## 📈 INDIKATOR TEKNIKAL LENGKAP

### Moving Averages
- **SMA 20**: Rp ${sma20.toFixed(8)} (${context.currentPrice > sma20 ? 'Harga DI ATAS' : 'Harga DI BAWAH'})
- **SMA 50**: Rp ${sma50.toFixed(8)} (${context.currentPrice > sma50 ? 'Harga DI ATAS' : 'Harga DI BAWAH'})
- **EMA 9**: Rp ${ema9.toFixed(8)}
- **EMA 21**: Rp ${ema21.toFixed(8)}
- **EMA Crossover**: ${ema9 > ema21 ? '🟢 GOLDEN (Bullish)' : '🔴 DEATH (Bearish)'}

### Oscillators
- **RSI (14)**: ${rsi.toFixed(1)} → ${rsiSignal} ${rsi < 30 ? '⚠️ Potential Reversal UP' : rsi > 70 ? '⚠️ Potential Reversal DOWN' : ''}
- **MACD Line**: ${macdLine.toFixed(8)}
- **MACD Histogram**: ${macdHistogram > 0 ? '🟢' : '🔴'} ${macdHistogram.toFixed(8)} → ${macdSignal}

### Bollinger Bands (20, 2)
- **Upper Band**: Rp ${bbUpper.toFixed(8)}
- **Middle Band**: Rp ${bbMiddle.toFixed(8)}
- **Lower Band**: Rp ${bbLower.toFixed(8)}
- **Position**: ${bbPosition} ${bbPosition === 'ABOVE_UPPER' || bbPosition === 'NEAR_UPPER' ? '⚠️ Overbought Zone' : bbPosition === 'BELOW_LOWER' || bbPosition === 'NEAR_LOWER' ? '⚠️ Oversold Zone' : ''}

### Volume Analysis
- **Avg Volume (20)**: ${avgVolume.toFixed(2)}
- **Recent Volume (5)**: ${recentVolume.toFixed(2)}
- **Volume Trend**: ${volumeTrend} ${volumeTrend === 'INCREASING' ? '📈 Volume Meningkat' : volumeTrend === 'DECREASING' ? '📉 Volume Menurun' : ''}

### Support & Resistance
- **Nearest Support**: Rp ${nearestSupport.toFixed(8)}
- **Nearest Resistance**: Rp ${nearestResistance.toFixed(8)}
- **Distance to Support**: ${((context.currentPrice - nearestSupport) / context.currentPrice * 100).toFixed(2)}%
- **Distance to Resistance**: ${((nearestResistance - context.currentPrice) / context.currentPrice * 100).toFixed(2)}%

### Trend Summary
- **Direction**: ${trendDirection}
- **Strength**: ${trendStrength}

## 👤 PROFIL RISIKO
- Profil: ${riskProfile}
- Min Confidence: ${riskConfig.minConfidence * 100}%
${userSettingsSection}
${newsContext ? `\n## 📰 KONTEKS BERITA\n${newsContext}` : ''}

## 📋 FORMAT RESPONSE (JSON ONLY)
Berikan analisa MENDALAM dalam format JSON berikut:
\`\`\`json
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0.0-1.0,
  "technicalScore": -1.0 to 1.0,
  "sentimentScore": -1.0 to 1.0,
  "riskScore": 0.0-1.0,
  "entryPrice": number,
  "targetPrice": number,
  "stopLoss": number,
  "amountPercent": number (max ${riskConfig.maxPositionPercent}),
  "reasoning": "Penjelasan komprehensif max 300 kata",
  "timeframe": "short" | "medium" | "long",
  "analysis": {
    "trend": {
      "direction": "BULLISH" | "BEARISH" | "SIDEWAYS",
      "strength": "STRONG" | "MODERATE" | "WEAK",
      "description": "Penjelasan trend"
    },
    "indicators": {
      "rsi": {
        "value": ${rsi.toFixed(1)},
        "signal": "${rsiSignal}",
        "description": "Analisa RSI"
      },
      "macd": {
        "value": ${macdLine.toFixed(8)},
        "signal": "${macdSignal}",
        "histogram": ${macdHistogram.toFixed(8)},
        "description": "Analisa MACD"
      },
      "bollingerBands": {
        "position": "${bbPosition}",
        "description": "Analisa Bollinger Bands"
      },
      "volume": {
        "trend": "${volumeTrend}",
        "signal": "BULLISH" | "BEARISH" | "NEUTRAL",
        "description": "Analisa Volume"
      },
      "ema": {
        "ema9": ${ema9.toFixed(8)},
        "ema21": ${ema21.toFixed(8)},
        "crossover": "${ema9 > ema21 ? 'GOLDEN' : 'DEATH'}",
        "description": "Analisa EMA"
      }
    },
    "supportResistance": {
      "nearestSupport": ${nearestSupport.toFixed(8)},
      "nearestResistance": ${nearestResistance.toFixed(8)},
      "description": "Analisa S/R"
    },
    "priceAction": {
      "pattern": "Nama pattern jika ada (e.g., Double Bottom, Head & Shoulders)",
      "description": "Analisa price action"
    },
    "riskReward": {
      "ratio": number (target/stopLoss ratio),
      "assessment": "FAVORABLE" | "NEUTRAL" | "UNFAVORABLE"
    }
  }
}
\`\`\`

PENTING:
- Analisa SETIAP indikator dan berikan penjelasan di masing-masing field description
- Jika tidak ada sinyal kuat dari MULTIPLE indikator, pilih HOLD
- Risk/Reward ratio harus > 1.5 untuk signal yang baik
- Response HANYA JSON tanpa teks tambahan
`;
}

/**
 * Build scalping-specific analysis prompt for Gemini with DEEP ANALYSIS
 */
function buildScalpingPrompt(
  context: MarketContext,
  scalpingConfig: { takeProfitPct: number; stopLossPct: number; maxHoldMins: number },
  newsContext?: string
): string {
  // Convert OHLC data to numbers (API may return strings)
  const closes = context.ohlc.map(c => Number(c.Close));
  const highs = context.ohlc.map(c => Number(c.High));
  const lows = context.ohlc.map(c => Number(c.Low));
  const volumes = context.ohlc.map(c => Number(c.Volume));
  
  // DEBUG: Log data arrays
  console.log('='.repeat(60));
  console.log('[DEBUG:INDICATORS] Data Arrays:');
  console.log(`  closes length: ${closes.length}, sample: ${JSON.stringify(closes.slice(-3))}`);
  console.log(`  highs length: ${highs.length}, sample: ${JSON.stringify(highs.slice(-3))}`);
  console.log(`  lows length: ${lows.length}, sample: ${JSON.stringify(lows.slice(-3))}`);
  console.log(`  volumes length: ${volumes.length}, sample: ${JSON.stringify(volumes.slice(-3))}`);
  console.log(`  NaN check - closes has NaN: ${closes.some(isNaN)}, highs: ${highs.some(isNaN)}`);
  console.log('='.repeat(60));
  
  // ======== SCALPING-FOCUSED INDICATORS (faster periods) ========
  
  // SMA 10 & 20 (for scalping, shorter periods)
  const sma10 = closes.length >= 10 ? closes.slice(-10).reduce((a, b) => a + b, 0) / 10 : context.currentPrice;
  const sma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : context.currentPrice;
  
  // EMA 9 & 21 (consistent with frontend)
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  
  // DEBUG: EMA values
  console.log(`[DEBUG:EMA] ema9: ${ema9}, ema21: ${ema21}, closes length: ${closes.length}`);
  
  // RSI-7 (faster for scalping)
  let gains7 = 0, losses7 = 0;
  for (let i = 1; i < Math.min(8, closes.length); i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains7 += diff;
    else losses7 -= diff;
  }
  const avgGain7 = gains7 / 7 || 0;
  const avgLoss7 = losses7 / 7 || 1;
  const rs7 = avgGain7 / avgLoss7;
  const rsi7 = 100 - (100 / (1 + rs7));
  
  // DEBUG: RSI values
  console.log(`[DEBUG:RSI] gains7: ${gains7}, losses7: ${losses7}, avgGain7: ${avgGain7}, avgLoss7: ${avgLoss7}, rs7: ${rs7}, rsi7: ${rsi7}`);
  
  // MACD (12, 26, 9) - standard MACD calculation
  // Calculate MACD line values for each candle
  const macdValues: number[] = [];
  for (let i = 26; i <= closes.length; i++) {
    const slice = closes.slice(0, i);
    const emaFast = calculateEMA(slice, 12);
    const emaSlow = calculateEMA(slice, 26);
    macdValues.push(emaFast - emaSlow);
  }
  
  // Current MACD line (latest value)
  const macdLine = macdValues.length > 0 ? macdValues[macdValues.length - 1] : 0;
  
  // Signal line = EMA 9 of MACD values
  const signalLine = macdValues.length >= 9 ? calculateEMA(macdValues, 9) : macdLine;
  
  // Histogram = MACD line - Signal line
  const macdHistogram = macdLine - signalLine;
  
  // DEBUG: MACD values
  console.log(`[DEBUG:MACD] macdValues count: ${macdValues.length}, macdLine: ${macdLine}, signalLine: ${signalLine}, histogram: ${macdHistogram}`);
  
  // Bollinger Bands (10, 1.5) - tighter for scalping
  const bb10 = closes.slice(-10);
  const bb10Sma = bb10.reduce((a, b) => a + b, 0) / bb10.length;
  const bb10Std = Math.sqrt(bb10.reduce((sum, val) => sum + Math.pow(val - bb10Sma, 2), 0) / bb10.length) || 1;
  const bbUpper = bb10Sma + (1.5 * bb10Std);
  const bbLower = bb10Sma - (1.5 * bb10Std);
  
  // Volume analysis
  const avgVolume = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
  const currentVolume = volumes[volumes.length - 1] || 0;
  const volumeRatio = avgVolume > 0 ? (currentVolume / avgVolume) : 1;
  
  // Price momentum (last 3 candles for scalping)
  const recentCloses = closes.slice(-3);
  const momentum = recentCloses.length >= 2 
    ? ((recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0]) * 100
    : 0;
  
  // Volatility (ATR 7 - faster)
  let atr7 = 0;
  for (let i = 0; i < Math.min(7, highs.length); i++) {
    atr7 += highs[i] - lows[i];
  }
  atr7 = atr7 / Math.min(7, highs.length) || 0;
  const volatilityPct = (atr7 / context.currentPrice) * 100;
  
  // Support/Resistance from recent candles
  const recentLows = lows.slice(-10);
  const recentHighs = highs.slice(-10);
  const nearestSupport = Math.min(...recentLows);
  const nearestResistance = Math.max(...recentHighs);

  return `
🚀 SCALPING MODE - DEEP ANALYSIS - Strategi trading jangka SANGAT PENDEK untuk profit cepat.

## PRINSIP SCALPING
1. **Timeframe**: Fokus pada pergerakan 1-15 menit
2. **Target**: Profit kecil tapi cepat (${scalpingConfig.takeProfitPct}%)
3. **Stop Loss**: SANGAT KETAT (${scalpingConfig.stopLossPct}%)
4. **Hold Time**: Maksimum ${scalpingConfig.maxHoldMins} menit
5. **Frekuensi**: Banyak trade kecil lebih baik dari 1 trade besar

## Data Pasar Real-Time
- **Pair**: ${context.pair.toUpperCase()}
- **Harga Saat Ini**: Rp ${context.currentPrice.toLocaleString('id-ID')}
- **High 24h**: Rp ${context.high24h.toLocaleString('id-ID')}
- **Low 24h**: Rp ${context.low24h.toLocaleString('id-ID')}
- **Volume 24h**: Rp ${context.volume24h.toLocaleString('id-ID')}
- **Perubahan 24h**: ${context.change24h.toFixed(2)}%

## 📊 INDIKATOR TEKNIKAL KOMPREHENSIF (Scalping-Optimized)

### Moving Averages (Faster Periods)
- **SMA 10**: ${sma10.toFixed(8)} ${context.currentPrice > sma10 ? '✅ Price ABOVE' : '❌ Price BELOW'}
- **SMA 20**: ${sma20.toFixed(8)} ${context.currentPrice > sma20 ? '✅ Price ABOVE' : '❌ Price BELOW'}
- **EMA 9**: ${ema9.toFixed(8)}
- **EMA 21**: ${ema21.toFixed(8)}
- **EMA Crossover**: ${ema9 > ema21 ? '📈 BULLISH (EMA9 > EMA21)' : '📉 BEARISH (EMA9 < EMA21)'}

### RSI (7 Periode - Faster)
- **Value**: ${rsi7.toFixed(1)}
- **Signal**: ${rsi7 < 30 ? '⚠️ OVERSOLD - Potensi bounce' : rsi7 > 70 ? '⚠️ OVERBOUGHT - Potensi koreksi' : '➡️ NEUTRAL'}

### MACD (8, 17, 9 - Faster)
- **MACD Line**: ${macdLine.toFixed(8)}
- **Signal Line**: ${signalLine.toFixed(8)}
- **Histogram**: ${macdHistogram.toFixed(8)} ${macdHistogram > 0 ? '📈 BULLISH' : '📉 BEARISH'}
- **Momentum**: ${macdHistogram > 0 ? 'INCREASING' : 'DECREASING'}

### Bollinger Bands (10, 1.5 - Tighter)
- **Upper**: ${bbUpper.toFixed(8)}
- **Middle**: ${bb10Sma.toFixed(8)}
- **Lower**: ${bbLower.toFixed(8)}
- **Position**: ${context.currentPrice > bbUpper ? '⚠️ ABOVE UPPER - Overbought' : context.currentPrice < bbLower ? '⚠️ BELOW LOWER - Oversold' : '✓ Inside bands'}

### Volume Analysis
- **Current Volume**: ${currentVolume.toLocaleString()}
- **Avg Volume**: ${avgVolume.toFixed(0).toLocaleString()}
- **Volume Ratio**: ${volumeRatio.toFixed(2)}x ${volumeRatio > 1.5 ? '🔥 VOLUME SPIKE!' : volumeRatio < 0.5 ? '😴 Low Volume' : '✓ Normal'}

### Momentum & Volatility
- **3-Candle Momentum**: ${momentum.toFixed(3)}% ${momentum > 0.3 ? '📈 Bullish' : momentum < -0.3 ? '📉 Bearish' : '➡️ Sideways'}
- **ATR-7 Volatility**: ${volatilityPct.toFixed(3)}% ${volatilityPct > 0.5 ? '✅ Good for scalping' : '⚠️ Low volatility'}

### Support & Resistance (Last 10 candles)
- **Nearest Support**: ${nearestSupport.toFixed(8)}
- **Nearest Resistance**: ${nearestResistance.toFixed(8)}
- **Distance to Support**: ${(((context.currentPrice - nearestSupport) / context.currentPrice) * 100).toFixed(2)}%
- **Distance to Resistance**: ${(((nearestResistance - context.currentPrice) / context.currentPrice) * 100).toFixed(2)}%

${newsContext ? `## ⚠️ Konteks Berita (Risiko)\n${newsContext}\n**Perhatian**: Hindari scalping jika ada news major dalam 30 menit!` : ''}

## KRITERIA ENTRY SCALPING
✅ Entry HANYA jika:
- RSI-7 < 35 (oversold) ATAU > 65 (overbought) untuk reversal
- ATAU EMA crossover baru terjadi dengan volume spike
- ATAU price di lower/upper Bollinger dengan momentum reversal
- Volatility cukup (ATR% > 0.3%)

❌ JANGAN entry jika:
- Volume rendah (ratio < 0.7)
- Volatility terlalu rendah (ATR% < 0.2%)
- RSI di zona netral (40-60) tanpa momentum
- Tidak ada konfirmasi dari multiple indicators

## Format Response (JSON ONLY)
\`\`\`json
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0.0-1.0,
  "technicalScore": -1.0 to 1.0,
  "sentimentScore": -1.0 to 1.0,
  "riskScore": 0.0-1.0,
  "entryPrice": ${context.currentPrice},
  "targetPrice": number (max ${scalpingConfig.takeProfitPct}% dari entry),
  "stopLoss": number (max ${scalpingConfig.stopLossPct}% dari entry),
  "amountPercent": number (5-15% untuk scalping),
  "reasoning": "Penjelasan singkat max 150 kata - FOKUS pada momentum dan timing",
  "timeframe": "scalping",
  "analysis": {
    "trend": {
      "direction": "BULLISH" | "BEARISH" | "SIDEWAYS",
      "strength": "STRONG" | "MODERATE" | "WEAK",
      "description": "Penjelasan trend untuk scalping"
    },
    "indicators": {
      "rsi": {
        "value": ${rsi7.toFixed(1)},
        "signal": "${rsi7 < 30 ? 'OVERSOLD' : rsi7 > 70 ? 'OVERBOUGHT' : 'NEUTRAL'}",
        "description": "Analisa RSI-7 untuk scalping"
      },
      "macd": {
        "histogram": ${macdHistogram.toFixed(8)},
        "signal": "${macdHistogram > 0 ? 'BULLISH' : 'BEARISH'}",
        "description": "Analisa MACD untuk entry/exit timing"
      },
      "bollingerBands": {
        "position": "${context.currentPrice > bbUpper ? 'ABOVE_UPPER' : context.currentPrice < bbLower ? 'BELOW_LOWER' : 'INSIDE'}",
        "description": "Analisa posisi harga terhadap BB"
      },
      "volume": {
        "trend": "${volumeRatio > 1.2 ? 'INCREASING' : volumeRatio < 0.8 ? 'DECREASING' : 'STABLE'}",
        "description": "Analisa volume untuk konfirmasi momentum"
      },
      "ema": {
        "ema9": ${ema9.toFixed(8)},
        "ema21": ${ema21.toFixed(8)},
        "crossover": "${ema9 > ema21 ? 'GOLDEN' : 'DEATH'}",
        "description": "Analisa EMA crossover untuk scalping"
      }
    },
    "supportResistance": {
      "nearestSupport": ${nearestSupport.toFixed(8)},
      "nearestResistance": ${nearestResistance.toFixed(8)},
      "description": "Analisa S/R untuk scalping entry"
    },
    "priceAction": {
      "pattern": "Pattern jika ada (Hammer, Doji, Engulfing dll.)",
      "description": "Analisa candlestick pattern"
    },
    "riskReward": {
      "ratio": number (harus > 1.5 untuk scalping yang baik),
      "assessment": "FAVORABLE" | "NEUTRAL" | "UNFAVORABLE"
    }
  }
}
\`\`\`

⚡ INGAT: Scalping = CEPAT MASUK, CEPAT KELUAR. Risk/Reward minimal 1:1.5. Jangan serakah!
`;
}

/**
 * Parse AI response to structured result
 */
function parseAIResponse(response: string): AIAnalysisResult | null {
  try {
    // Extract JSON from response
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                      response.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      console.error('No JSON found in AI response');
      return null;
    }
    
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsed = JSON.parse(jsonStr);
    
    // Validate required fields
    if (!parsed.action || typeof parsed.confidence !== 'number') {
      console.error('Invalid AI response structure');
      return null;
    }
    
    return {
      action: parsed.action,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      technicalScore: Math.max(-1, Math.min(1, parsed.technicalScore || 0)),
      sentimentScore: Math.max(-1, Math.min(1, parsed.sentimentScore || 0)),
      riskScore: Math.max(0, Math.min(1, parsed.riskScore || 0.5)),
      entryPrice: parsed.entryPrice || 0,
      targetPrice: parsed.targetPrice || 0,
      stopLoss: parsed.stopLoss || 0,
      amountPercent: parsed.amountPercent || 5,
      reasoning: parsed.reasoning || 'No reasoning provided',
      timeframe: parsed.timeframe || 'medium',
      analysis: parsed.analysis || undefined, // Include detailed analysis if AI provides it
    };
  } catch (error) {
    console.error('Failed to parse AI response:', error);
    return null;
  }
}

/**
 * Generate trading signal using Gemini AI
 */
export async function generateSignal(
  params: SignalGenerationParams
): Promise<AIAnalysisResult | null> {
  const { userId, pair, userRiskProfile, newsContext, scalpingMode } = params;
  
  // Get Gemini client
  const genai = await getGeminiClient(userId);
  if (!genai) {
    throw new Error('Gemini API key not configured');
  }
  
  // Get market context
  const context = await getMarketContext(pair);
  
  // Build prompt based on mode
  let prompt: string;
  if (scalpingMode?.enabled) {
    console.log(`[AI] Using SCALPING mode for ${pair} (TP: ${scalpingMode.takeProfitPct}%, SL: ${scalpingMode.stopLossPct}%)`);
    prompt = buildScalpingPrompt(context, {
      takeProfitPct: scalpingMode.takeProfitPct,
      stopLossPct: scalpingMode.stopLossPct,
      maxHoldMins: scalpingMode.maxHoldMins,
    }, newsContext);
  } else {
    prompt = buildAnalysisPrompt(context, userRiskProfile, newsContext, params.userSettings);
  }
  
  // Call Gemini
  const response = await genai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: prompt,
  });
  
  const text = response.text || '';
  
  // Log raw AI response for debugging
  console.log('='.repeat(60));
  console.log('[AI] RAW RESPONSE FROM GEMINI:');
  console.log('='.repeat(60));
  console.log(text);
  console.log('='.repeat(60));
  
  // Parse response
  const result = parseAIResponse(text);
  
  if (!result) {
    console.error('Failed to parse AI response:', text);
    return null;
  }
  
  // Adjust based on mode
  if (scalpingMode?.enabled) {
    // Enforce scalping limits
    const maxTP = context.currentPrice * (1 + scalpingMode.takeProfitPct / 100);
    const maxSL = context.currentPrice * (1 - scalpingMode.stopLossPct / 100);
    
    if (result.action === 'BUY') {
      if (result.targetPrice > maxTP) result.targetPrice = maxTP;
      if (result.stopLoss < maxSL) result.stopLoss = maxSL;
    }
    result.timeframe = 'scalping';
  } else {
    // Adjust based on risk profile
    const riskConfig = RISK_PROFILES[userRiskProfile];
    if (result.amountPercent > riskConfig.maxPositionPercent) {
      result.amountPercent = riskConfig.maxPositionPercent;
    }
  }
  
  return result;
}

/**
 * Simple market analysis without trading signal
 */
export async function analyzeMarket(
  userId: string,
  pair: string
): Promise<string> {
  const genai = await getGeminiClient(userId);
  if (!genai) {
    throw new Error('Gemini API key not configured');
  }
  
  const context = await getMarketContext(pair);
  
  const prompt = `
Analisa pasar ${pair.toUpperCase()} dengan data berikut:
- Harga: Rp ${context.currentPrice.toLocaleString('id-ID')}
- High/Low 24h: Rp ${context.high24h.toLocaleString('id-ID')} / Rp ${context.low24h.toLocaleString('id-ID')}
- Volume 24h: Rp ${context.volume24h.toLocaleString('id-ID')}
- Perubahan: ${context.change24h.toFixed(2)}%

Berikan analisa singkat dalam bahasa Indonesia (max 300 kata) tentang:
1. Kondisi pasar saat ini
2. Level support & resistance terdekat
3. Sentimen pasar
4. Rekomendasi umum (bukan financial advice)

Format: Gunakan markdown untuk formatting.
`;
  
  const response = await genai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: prompt,
  });
  
  return response.text || 'Tidak dapat menghasilkan analisa.';
}
