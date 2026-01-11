import { Router } from 'express';
import { indodaxPublicAPI } from '../services/indodax.js';
import { optionalAuth } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/market/pairs
 * Get all available trading pairs
 */
router.get('/pairs', async (req, res) => {
  try {
    const pairs = await indodaxPublicAPI.getPairs();
    res.json({ pairs });
  } catch (error) {
    console.error('Get pairs error:', error);
    res.status(500).json({ error: 'Failed to fetch pairs' });
  }
});

/**
 * GET /api/market/pairs/search
 * Search pairs by keyword (minimum 3 characters)
 */
router.get('/pairs/search', async (req, res) => {
  try {
    const { q } = req.query;
    const keyword = (q as string || '').toLowerCase().trim();
    
    if (keyword.length < 3) {
      res.status(400).json({ error: 'Keyword must be at least 3 characters' });
      return;
    }
    
    // Get all pairs and summaries for filtering
    const [pairsData, summaries] = await Promise.all([
      indodaxPublicAPI.getPairs(),
      indodaxPublicAPI.getSummaries(),
    ]);
    
    // Filter pairs that match keyword (in pair name or description)
    const matchingPairs = pairsData.filter((pair: any) => {
      const pairId = pair.id?.toLowerCase() || '';
      const description = pair.description?.toLowerCase() || '';
      const baseCurrency = pair.base_currency?.toLowerCase() || '';
      const tradedCurrency = pair.traded_currency?.toLowerCase() || '';
      
      return pairId.includes(keyword) || 
             description.includes(keyword) ||
             baseCurrency.includes(keyword) ||
             tradedCurrency.includes(keyword);
    });
    
    // Add price and volume info from summaries
    const enrichedPairs = matchingPairs.map((pair: any) => {
      // Construct proper pair ID with underscore: traded_currency_base_currency (e.g., xrp_idr)
      const tradedCurrency = (pair.traded_currency || '').toLowerCase();
      const baseCurrency = (pair.base_currency || 'idr').toLowerCase();
      const pairId = tradedCurrency && baseCurrency ? `${tradedCurrency}_${baseCurrency}` : pair.id?.toLowerCase();
      
      // Ticker key in summaries uses the pair.id format (might be without underscore)
      const tickerKey = pair.id?.toLowerCase() || pairId;
      const ticker = summaries.tickers?.[tickerKey] as any;
      
      return {
        id: pairId,
        symbol: tradedCurrency?.toUpperCase() || pairId?.split('_')[0]?.toUpperCase(),
        name: pair.description || pairId,
        baseCurrency: baseCurrency,
        tradedCurrency: tradedCurrency,
        price: ticker ? parseFloat(ticker.last || '0') : null,
        volume24h: ticker ? parseFloat(ticker.vol_idr || ticker.vol_base || '0') : null,
        change24h: ticker ? parseFloat(ticker.price_24h || ticker.last || '0') : null,
      };
    });
    
    // Sort by volume (highest first)
    enrichedPairs.sort((a: any, b: any) => (b.volume24h || 0) - (a.volume24h || 0));
    
    res.json({ 
      pairs: enrichedPairs.slice(0, 20), // Limit to 20 results
      total: enrichedPairs.length,
    });
  } catch (error) {
    console.error('Search pairs error:', error);
    res.status(500).json({ error: 'Failed to search pairs' });
  }
});

/**
 * GET /api/market/summaries
 * Get market summaries (all pairs)
 */
router.get('/summaries', async (req, res) => {
  try {
    const data = await indodaxPublicAPI.getSummaries();
    res.json(data);
  } catch (error) {
    console.error('Get summaries error:', error);
    res.status(500).json({ error: 'Failed to fetch summaries' });
  }
});

/**
 * GET /api/market/ticker/:pair
 * Get ticker for a specific pair
 */
router.get('/ticker/:pair', async (req, res) => {
  try {
    const { pair } = req.params;
    const data = await indodaxPublicAPI.getTicker(pair);
    res.json(data);
  } catch (error) {
    console.error('Get ticker error:', error);
    res.status(500).json({ error: 'Failed to fetch ticker' });
  }
});

/**
 * GET /api/market/depth/:pair
 * Get order book depth for a pair
 */
router.get('/depth/:pair', async (req, res) => {
  try {
    const { pair } = req.params;
    const data = await indodaxPublicAPI.getDepth(pair);
    res.json(data);
  } catch (error) {
    console.error('Get depth error:', error);
    res.status(500).json({ error: 'Failed to fetch depth' });
  }
});

/**
 * GET /api/market/trades/:pair
 * Get recent trades for a pair
 */
router.get('/trades/:pair', async (req, res) => {
  try {
    const { pair } = req.params;
    const trades = await indodaxPublicAPI.getTrades(pair);
    res.json({ trades });
  } catch (error) {
    console.error('Get trades error:', error);
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

/**
 * GET /api/market/ohlc/:pair
 * Get OHLC candlestick data
 */
router.get('/ohlc/:pair', async (req, res) => {
  try {
    const { pair } = req.params;
    const { timeframe = '15', from, to } = req.query;
    
    const now = Math.floor(Date.now() / 1000);
    const fromTime = from ? parseInt(from as string) : now - 24 * 60 * 60; // Default: 24h ago
    const toTime = to ? parseInt(to as string) : now;
    
    const ohlc = await indodaxPublicAPI.getOHLC(pair, timeframe as string, fromTime, toTime);
    res.json({ ohlc });
  } catch (error) {
    console.error('Get OHLC error:', error);
    res.status(500).json({ error: 'Failed to fetch OHLC data' });
  }
});

/**
 * GET /api/market/server-time
 * Get server time
 */
router.get('/server-time', async (req, res) => {
  try {
    const data = await indodaxPublicAPI.getServerTime();
    res.json(data);
  } catch (error) {
    console.error('Get server time error:', error);
    res.status(500).json({ error: 'Failed to fetch server time' });
  }
});

export default router;
