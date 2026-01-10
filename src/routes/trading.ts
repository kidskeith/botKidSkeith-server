import { Router } from 'express';
import { z } from 'zod';
import prisma from '../config/database.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { IndodaxPrivateAPI } from '../services/indodax.js';
import { decrypt, generateClientOrderId } from '../utils/index.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ============== Helper Functions ==============

async function getUserIndodaxAPI(userId: string): Promise<IndodaxPrivateAPI | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      indodaxApiKey: true,
      indodaxSecretKey: true,
    },
  });
  
  if (!user?.indodaxApiKey || !user?.indodaxSecretKey) {
    return null;
  }
  
  try {
    const apiKey = decrypt(user.indodaxApiKey);
    const secretKey = decrypt(user.indodaxSecretKey);
    
    // Debug: Log key lengths (not the actual keys!)
    console.log(`[Indodax] API Key length: ${apiKey.length}, starts with: ${apiKey.substring(0, 4)}...`);
    console.log(`[Indodax] Secret Key length: ${secretKey.length}, starts with: ${secretKey.substring(0, 4)}...`);
    
    return new IndodaxPrivateAPI(apiKey, secretKey);
  } catch (error) {
    console.error('[Indodax] Failed to decrypt API keys:', error);
    throw new Error('Failed to decrypt API keys');
  }
}

// ============== Schemas ==============

const placeOrderSchema = z.object({
  pair: z.string().min(3),
  type: z.enum(['buy', 'sell']),
  price: z.number().positive(),
  amount: z.number().positive().optional(),
  idr: z.number().positive().optional(),
  orderType: z.enum(['limit', 'market']).optional().default('limit'),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
});

// ============== Routes ==============

/**
 * GET /api/account/balance
 * Get account balance from Indodax
 */
router.get('/balance', async (req: AuthRequest, res) => {
  try {
    const api = await getUserIndodaxAPI(req.userId!);
    
    if (!api) {
      res.status(400).json({ error: 'Indodax API keys not configured' });
      return;
    }
    
    const info = await api.getInfo();
    
    res.json({
      balance: info.balance,
      balanceHold: info.balance_hold,
      userId: info.user_id,
      email: info.email,
      name: info.name,
      verified: info.verification_status === 'verified',
    });
  } catch (error: any) {
    console.error('Get balance error:', error);
    res.status(500).json({ error: error.message || 'Failed to get balance' });
  }
});

/**
 * GET /api/account/positions
 * Get open positions from database
 */
router.get('/positions', async (req: AuthRequest, res) => {
  try {
    const positions = await prisma.position.findMany({
      where: {
        userId: req.userId,
        status: 'OPEN',
      },
      orderBy: { createdAt: 'desc' },
      include: {
        signal: {
          select: {
            id: true,
            action: true,
            confidence: true,
            reasoning: true,
          },
        },
      },
    });
    
    res.json({ positions });
  } catch (error) {
    console.error('Get positions error:', error);
    res.status(500).json({ error: 'Failed to get positions' });
  }
});

/**
 * GET /api/trades
 * Get trade history
 */
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { limit = 50, status, pair } = req.query;
    
    const trades = await prisma.trade.findMany({
      where: {
        userId: req.userId,
        ...(status && { status: status as any }),
        ...(pair && { pair: pair as string }),
      },
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      include: {
        signal: {
          select: {
            id: true,
            action: true,
            confidence: true,
          },
        },
      },
    });
    
    res.json({ trades });
  } catch (error) {
    console.error('Get trades error:', error);
    res.status(500).json({ error: 'Failed to get trades' });
  }
});

/**
 * GET /api/trades/open
 * Get open orders from Indodax
 */
router.get('/open', async (req: AuthRequest, res) => {
  try {
    const api = await getUserIndodaxAPI(req.userId!);
    
    if (!api) {
      res.status(400).json({ error: 'Indodax API keys not configured' });
      return;
    }
    
    const { pair } = req.query;
    const result = await api.getOpenOrders(pair as string | undefined);
    
    res.json({ orders: result.orders });
  } catch (error: any) {
    console.error('Get open orders error:', error);
    res.status(500).json({ error: error.message || 'Failed to get open orders' });
  }
});

/**
 * GET /api/trades/:id
 * Get specific trade details
 */
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    
    const trade = await prisma.trade.findFirst({
      where: {
        id,
        userId: req.userId,
      },
      include: {
        signal: true,
      },
    });
    
    if (!trade) {
      res.status(404).json({ error: 'Trade not found' });
      return;
    }
    
    res.json({ trade });
  } catch (error) {
    console.error('Get trade error:', error);
    res.status(500).json({ error: 'Failed to get trade' });
  }
});

/**
 * POST /api/trades
 * Place a new trade order
 */
router.post('/', validateBody(placeOrderSchema), async (req: AuthRequest, res) => {
  try {
    const api = await getUserIndodaxAPI(req.userId!);
    
    if (!api) {
      res.status(400).json({ error: 'Indodax API keys not configured' });
      return;
    }
    
    const { pair, type, price, amount, idr, orderType, stopLoss, takeProfit } = req.body;
    
    // Generate client order ID
    const clientOrderId = generateClientOrderId('manual');
    
    // Create trade record (pending)
    const trade = await prisma.trade.create({
      data: {
        userId: req.userId!,
        clientOrderId,
        pair,
        type: type.toUpperCase() as 'BUY' | 'SELL',
        orderType: orderType.toUpperCase() as 'LIMIT' | 'MARKET',
        price,
        amount: amount || 0,
        cost: idr || (amount ? amount * price : 0),
        stopLoss,
        takeProfit,
        status: 'PENDING',
      },
    });
    
    try {
      // Place order on Indodax
      const result = await api.trade({
        pair,
        type,
        price,
        amount,
        idr,
        orderType,
        clientOrderId,
      });
      
      // Update trade with order ID
      const updatedTrade = await prisma.trade.update({
        where: { id: trade.id },
        data: {
          orderId: result.order_id.toString(),
          status: 'PLACED',
          placedAt: new Date(),
        },
      });
      
      res.status(201).json({
        message: 'Order placed successfully',
        trade: updatedTrade,
        indodaxResult: result,
      });
    } catch (orderError: any) {
      // Update trade status to failed
      await prisma.trade.update({
        where: { id: trade.id },
        data: { status: 'FAILED' },
      });
      
      throw orderError;
    }
  } catch (error: any) {
    console.error('Place order error:', error);
    res.status(500).json({ error: error.message || 'Failed to place order' });
  }
});

/**
 * DELETE /api/trades/:id
 * Cancel an open order
 */
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    
    // Find trade
    const trade = await prisma.trade.findFirst({
      where: {
        id,
        userId: req.userId,
        status: { in: ['PENDING', 'PLACED', 'PARTIAL'] },
      },
    });
    
    if (!trade) {
      res.status(404).json({ error: 'Trade not found or cannot be cancelled' });
      return;
    }
    
    const api = await getUserIndodaxAPI(req.userId!);
    
    if (!api) {
      res.status(400).json({ error: 'Indodax API keys not configured' });
      return;
    }
    
    // Cancel on Indodax
    if (trade.orderId) {
      await api.cancelOrder(
        trade.pair,
        parseInt(trade.orderId),
        trade.type.toLowerCase() as 'buy' | 'sell'
      );
    }
    
    // Update trade status
    const updatedTrade = await prisma.trade.update({
      where: { id: trade.id },
      data: { status: 'CANCELLED' },
    });
    
    res.json({
      message: 'Order cancelled',
      trade: updatedTrade,
    });
  } catch (error: any) {
    console.error('Cancel order error:', error);
    res.status(500).json({ error: error.message || 'Failed to cancel order' });
  }
});

/**
 * GET /api/trades/history/:pair
 * Get trade history for a pair from Indodax
 */
router.get('/history/:pair', async (req: AuthRequest, res) => {
  try {
    const api = await getUserIndodaxAPI(req.userId!);
    
    if (!api) {
      res.status(400).json({ error: 'Indodax API keys not configured' });
      return;
    }
    
    const { pair } = req.params;
    const { count = 100 } = req.query;
    
    const result = await api.getTradeHistory(pair, Number(count));
    
    res.json({ trades: result.trades });
  } catch (error: any) {
    console.error('Get trade history error:', error);
    res.status(500).json({ error: error.message || 'Failed to get trade history' });
  }
});

/**
 * GET /api/trades/orders/:pair
 * Get order history for a pair from Indodax
 */
router.get('/orders/:pair', async (req: AuthRequest, res) => {
  try {
    const api = await getUserIndodaxAPI(req.userId!);
    
    if (!api) {
      res.status(400).json({ error: 'Indodax API keys not configured' });
      return;
    }
    
    const { pair } = req.params;
    const { count = 100 } = req.query;
    
    const result = await api.getOrderHistory(pair, Number(count));
    
    res.json({ orders: result.orders });
  } catch (error: any) {
    console.error('Get order history error:', error);
    res.status(500).json({ error: error.message || 'Failed to get order history' });
  }
});

export default router;
