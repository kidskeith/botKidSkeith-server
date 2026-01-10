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
