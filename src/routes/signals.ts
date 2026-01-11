import { Router } from 'express';
import { z } from 'zod';
import prisma from '../config/database.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { generateSignal, analyzeMarket, getMarketContext } from '../services/ai.js';
import { fetchCryptoNews } from '../services/news.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ============== Schemas ==============

const generateSignalSchema = z.object({
  pair: z.string().min(3),
  newsContext: z.string().optional(),
});

const updateSignalSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
});

// ============== Routes ==============

/**
 * POST /api/signals/generate
 * Generate a new AI trading signal
 */
router.post('/generate', validateBody(generateSignalSchema), async (req: AuthRequest, res) => {
  try {
    const { pair, newsContext: providedNewsContext } = req.body;
    
    // Get user settings
    const settings = await prisma.userSettings.findUnique({
      where: { userId: req.userId },
    });
    
    if (!settings) {
      res.status(400).json({ error: 'User settings not configured' });
      return;
    }
    
    // Check if pair is allowed
    if (settings.allowedPairs.length > 0 && !settings.allowedPairs.includes(pair)) {
      res.status(400).json({ error: `Pair ${pair} is not in allowed pairs list` });
      return;
    }
    
    // Check if already have open position for this pair
    const existingPosition = await prisma.position.findFirst({
      where: {
        userId: req.userId!,
        pair,
        status: 'OPEN',
      },
    });
    
    if (existingPosition) {
      res.json({
        message: `Already have open position for ${pair}. Wait for position to close or manually close it first.`,
        skipped: true,
        reason: 'existing_position',
        position: {
          id: existingPosition.id,
          entryPrice: Number(existingPosition.entryPrice),
          amount: Number(existingPosition.amount),
          stopLoss: existingPosition.stopLoss ? Number(existingPosition.stopLoss) : null,
          takeProfit: existingPosition.takeProfit ? Number(existingPosition.takeProfit) : null,
        },
      });
      return;
    }
    
    // Check total open positions limit
    const openPositionsCount = await prisma.position.count({
      where: {
        userId: req.userId!,
        status: 'OPEN',
      },
    });
    
    if (openPositionsCount >= settings.maxOpenPositions) {
      res.json({
        message: `Max open positions reached (${openPositionsCount}/${settings.maxOpenPositions}). Close some positions first.`,
        skipped: true,
        reason: 'max_positions_reached',
      });
      return;
    }
    
    // Auto-fetch news if not provided
    let newsContext = providedNewsContext;
    if (!newsContext) {
      console.log(`[Signal] Fetching news for ${pair}...`);
      newsContext = await fetchCryptoNews(pair);
      if (newsContext) {
        console.log(`[Signal] Found news context (${newsContext.length} chars)`);
      }
    }
    
    // Generate signal (pass user settings so AI knows preferences but gives its own recommendations)
    const result = await generateSignal({
      userId: req.userId!,
      pair,
      userRiskProfile: settings.riskProfile,
      newsContext,
      scalpingMode: settings.scalpingModeEnabled ? {
        enabled: true,
        takeProfitPct: settings.scalpingTakeProfitPct,
        stopLossPct: settings.scalpingStopLossPct,
        maxHoldMins: settings.scalpingMaxHoldMins,
      } : undefined,
      userSettings: {
        stopLossPercent: settings.stopLossPercent,
        takeProfitPercent: settings.takeProfitPercent,
        maxPositionPercent: settings.maxPositionPercent,
      },
    });
    
    if (!result) {
      res.status(500).json({ error: 'Failed to generate signal' });
      return;
    }
    
    // Log AI recommendations vs user settings for debugging
    const userStopLoss = result.entryPrice * (1 - settings.stopLossPercent / 100);
    const userTakeProfit = result.entryPrice * (1 + settings.takeProfitPercent / 100);
    console.log(`[Signal] AI recommendations - SL: ${result.stopLoss.toFixed(2)}, TP: ${result.targetPrice.toFixed(2)}, Amount: ${result.amountPercent}%`);
    console.log(`[Signal] User settings would be - SL: ${userStopLoss.toFixed(2)}, TP: ${userTakeProfit.toFixed(2)}, Amount: ${settings.maxPositionPercent}%`);
    
    // HOLD signals are not saved - just return analysis for display
    if (result.action === 'HOLD') {
      res.json({
        signal: result,  // Use 'signal' key so frontend can display it
        message: 'AI recommends HOLD - no action needed',
        skipped: true,
      });
      return;
    }
    
    // Check against minimum confidence
    if (result.confidence < settings.minConfidenceToTrade) {
      // Still save the signal but mark as SKIPPED
      const signal = await prisma.signal.create({
        data: {
          userId: req.userId!,
          pair,
          action: result.action,
          confidence: result.confidence,
          technicalScore: result.technicalScore,
          sentimentScore: result.sentimentScore,
          riskScore: result.riskScore,
          entryPrice: result.entryPrice,
          targetPrice: result.targetPrice,
          stopLoss: result.stopLoss,
          amountPercent: result.amountPercent,
          reasoning: result.reasoning,
          newsContext: newsContext || null,
          status: 'SKIPPED',
          validUntil: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        },
      });
      
      res.status(200).json({
        signal,
        message: `Signal confidence (${(result.confidence * 100).toFixed(1)}%) below minimum threshold (${(settings.minConfidenceToTrade * 100).toFixed(1)}%)`,
        skipped: true,
      });
      return;
    }
    
    // Save signal
    const signal = await prisma.signal.create({
      data: {
        userId: req.userId!,
        pair,
        action: result.action,
        confidence: result.confidence,
        technicalScore: result.technicalScore,
        sentimentScore: result.sentimentScore,
        riskScore: result.riskScore,
        entryPrice: result.entryPrice,
        targetPrice: result.targetPrice,
        stopLoss: result.stopLoss,
        amountPercent: result.amountPercent,
        reasoning: result.reasoning,
        newsContext: newsContext || null,
        status: settings.tradingMode === 'AUTONOMOUS' ? 'PENDING' : 'PENDING',
        validUntil: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });
    
    // If autonomous mode, we would execute the trade here
    // For now, just return the signal
    
    res.status(201).json({ 
      signal,
      analysis: result,
    });
  } catch (error: any) {
    console.error('Generate signal error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate signal' });
  }
});

/**
 * GET /api/signals
 * Get signal history
 */
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { limit = 50, status, pair } = req.query;
    
    const signals = await prisma.signal.findMany({
      where: {
        userId: req.userId,
        ...(status && { status: status as any }),
        ...(pair && { pair: pair as string }),
      },
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      include: {
        trades: {
          select: {
            id: true,
            orderId: true,
            status: true,
            pnl: true,
          },
        },
      },
    });
    
    res.json({ signals });
  } catch (error) {
    console.error('Get signals error:', error);
    res.status(500).json({ error: 'Failed to get signals' });
  }
});

/**
 * GET /api/signals/pending
 * Get pending signals for copilot mode
 */
router.get('/pending', async (req: AuthRequest, res) => {
  try {
    const signals = await prisma.signal.findMany({
      where: {
        userId: req.userId,
        status: 'PENDING',
        validUntil: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    
    res.json({ signals });
  } catch (error) {
    console.error('Get pending signals error:', error);
    res.status(500).json({ error: 'Failed to get pending signals' });
  }
});

/**
 * GET /api/signals/:id
 * Get specific signal details
 */
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    
    const signal = await prisma.signal.findFirst({
      where: {
        id,
        userId: req.userId,
      },
      include: {
        trades: true,
      },
    });
    
    if (!signal) {
      res.status(404).json({ error: 'Signal not found' });
      return;
    }
    
    res.json({ signal });
  } catch (error) {
    console.error('Get signal error:', error);
    res.status(500).json({ error: 'Failed to get signal' });
  }
});

/**
 * PATCH /api/signals/:id
 * Approve or reject a signal (copilot mode)
 */
router.patch('/:id', validateBody(updateSignalSchema), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    const signal = await prisma.signal.findFirst({
      where: {
        id,
        userId: req.userId,
        status: 'PENDING',
      },
    });
    
    if (!signal) {
      res.status(404).json({ error: 'Pending signal not found' });
      return;
    }
    
    // Check if still valid
    if (signal.validUntil < new Date()) {
      await prisma.signal.update({
        where: { id },
        data: { status: 'EXPIRED' },
      });
      res.status(400).json({ error: 'Signal has expired' });
      return;
    }
    
    // If rejected, just update status
    if (status === 'REJECTED') {
      const updated = await prisma.signal.update({
        where: { id },
        data: { status: 'REJECTED' },
      });
      res.json({ signal: updated, message: 'Signal rejected' });
      return;
    }
    
    // APPROVED - Execute the trade
    // Import position service
    const { openPosition, closePosition, getBotPositionAmount, findPositionToClose } = await import('../services/position.js');
    
    // For SELL signals, check if we have positions to sell
    if (signal.action === 'SELL') {
      const botAmount = await getBotPositionAmount(req.userId!, signal.pair);
      
      if (botAmount === 0) {
        res.status(400).json({ 
          error: 'No bot positions to sell',
          message: 'Cannot sell: The bot has not purchased any coins for this pair. Your original holdings are protected.',
        });
        return;
      }
      
      // Find position to close
      const positionToClose = await findPositionToClose(req.userId!, signal.pair);
      
      if (!positionToClose) {
        res.status(400).json({ error: 'No open positions found to close' });
        return;
      }
      
      // Get user's Indodax API keys
      const user = await prisma.user.findUnique({
        where: { id: req.userId! },
        select: { indodaxApiKey: true, indodaxSecretKey: true },
      });
      
      if (!user?.indodaxApiKey || !user?.indodaxSecretKey) {
        res.status(400).json({ error: 'Indodax API keys not configured. Please add your API keys in Settings.' });
        return;
      }
      
      // Import required modules
      const { IndodaxPrivateAPI } = await import('../services/indodax.js');
      const { decrypt, generateClientOrderId } = await import('../utils/index.js');
      
      // Create API client
      const api = new IndodaxPrivateAPI(
        decrypt(user.indodaxApiKey),
        decrypt(user.indodaxSecretKey)
      );
      
      const exitPrice = Number(signal.entryPrice);
      const sellAmount = Number(positionToClose.amount);
      const clientOrderId = generateClientOrderId('signal-sell');
      
      try {
        // Place SELL order on Indodax
        console.log(`[Signal] Placing SELL order: ${signal.pair} @ ${exitPrice}, amount: ${sellAmount}`);
        
        const tradeResult = await api.trade({
          pair: signal.pair,
          type: 'sell',
          price: exitPrice,
          amount: sellAmount,
          orderType: 'limit',
          clientOrderId,
        });
        
        console.log(`[Signal] SELL order placed. Order ID: ${tradeResult.order_id}`);
        
        // Close the position in database
        const closedPosition = await closePosition({
          positionId: positionToClose.id,
          exitPrice,
          reason: 'SIGNAL',
          exitTradeId: tradeResult.order_id.toString(),
        });
        
        // Create trade record
        await prisma.trade.create({
          data: {
            userId: req.userId!,
            orderId: tradeResult.order_id.toString(),
            clientOrderId,
            pair: signal.pair,
            type: 'SELL',
            orderType: 'LIMIT',
            price: exitPrice,
            amount: sellAmount,
            cost: sellAmount * exitPrice,
            status: 'PLACED',
            signalId: signal.id,
            aiConfidence: signal.confidence,
            aiReasoning: signal.reasoning,
            placedAt: new Date(),
            pnl: closedPosition.pnl,
            pnlPercent: closedPosition.pnlPercent,
          },
        });
        
        // Update signal to EXECUTED
        const updated = await prisma.signal.update({
          where: { id },
          data: { status: 'EXECUTED' },
        });
        
        res.json({
          signal: updated,
          message: 'SELL order placed on Indodax!',
          position: closedPosition,
          trade: {
            orderId: tradeResult.order_id,
            pair: signal.pair,
            amount: sellAmount,
            exitPrice,
          },
          pnl: Number(closedPosition.pnl),
          pnlPercent: closedPosition.pnlPercent,
        });
        return;
        
      } catch (tradeError: any) {
        console.error(`[Signal] SELL trade execution failed:`, tradeError.message);
        res.status(500).json({ 
          error: 'Failed to execute SELL trade',
          message: tradeError.message,
        });
        return;
      }
    }
    
    // For BUY signals, execute real trade on Indodax
    if (signal.action === 'BUY') {
      // Get user settings
      const settings = await prisma.userSettings.findUnique({
        where: { userId: req.userId! },
      });
      
      if (!settings) {
        res.status(400).json({ error: 'User settings not found' });
        return;
      }
      
      // Get user's Indodax API keys
      const user = await prisma.user.findUnique({
        where: { id: req.userId! },
        select: { indodaxApiKey: true, indodaxSecretKey: true },
      });
      
      if (!user?.indodaxApiKey || !user?.indodaxSecretKey) {
        res.status(400).json({ error: 'Indodax API keys not configured. Please add your API keys in Settings.' });
        return;
      }
      
      // Import required modules
      const { IndodaxPrivateAPI } = await import('../services/indodax.js');
      const { decrypt, generateClientOrderId } = await import('../utils/index.js');
      
      // Create API client
      const api = new IndodaxPrivateAPI(
        decrypt(user.indodaxApiKey),
        decrypt(user.indodaxSecretKey)
      );
      
      // Get real balance from Indodax
      let idrBalance: number;
      try {
        const accountInfo = await api.getInfo();
        idrBalance = parseFloat(String(accountInfo.balance.idr || '0'));
        console.log(`[Signal] User IDR balance: ${idrBalance.toLocaleString('id-ID')}`);
      } catch (balanceError: any) {
        res.status(400).json({ error: `Failed to get balance: ${balanceError.message}` });
        return;
      }
      
      // Calculate trade amount based on signal and settings
      const entryPrice = Number(signal.entryPrice);
      const maxPositionPercent = Math.min(signal.amountPercent, settings.maxPositionPercent);
      const cost = (idrBalance * maxPositionPercent) / 100;
      
      // Minimum trade amount check (Indodax minimum is typically 10,000 IDR)
      if (cost < 50000) {
        res.status(400).json({ 
          error: 'Insufficient balance',
          message: `Trade amount (${cost.toLocaleString('id-ID')} IDR) is below minimum. Need at least 50,000 IDR.`,
          balance: idrBalance,
        });
        return;
      }
      
      const clientOrderId = generateClientOrderId('signal');
      
      // Calculate amount of coin to buy (floor to integer - Indodax requires whole numbers)
      const amount = Math.floor(cost / entryPrice);
      
      // Verify amount is at least 1
      if (amount < 1) {
        res.status(400).json({ 
          error: 'Amount too small',
          message: `Calculated amount (${cost / entryPrice}) rounds to 0. Increase position size or choose a different coin.`,
        });
        return;
      }
      
      try {
        // Place BUY order on Indodax (limit orders require coin amount as integer)
        console.log(`[Signal] Placing BUY order: ${signal.pair} @ ${entryPrice}, amount: ${amount}, cost: ${(amount * entryPrice).toLocaleString('id-ID')} IDR`);
        
        const tradeResult = await api.trade({
          pair: signal.pair,
          type: 'buy',
          price: entryPrice,
          amount: amount, // Integer coin amount for limit orders
          orderType: 'limit',
          clientOrderId,
        });
        
        console.log(`[Signal] Order placed successfully. Order ID: ${tradeResult.order_id}`);
        
        // NOTE: Position will be created by Order Monitor when order status becomes FILLED
        // This prevents showing open position for unfilled orders
        
        // Create trade record with pending status
        const trade = await prisma.trade.create({
          data: {
            userId: req.userId!,
            orderId: tradeResult.order_id.toString(),
            clientOrderId,
            pair: signal.pair,
            type: 'BUY',
            orderType: 'LIMIT',
            price: entryPrice,
            amount,
            cost,
            stopLoss: Number(signal.stopLoss),
            takeProfit: Number(signal.targetPrice),
            status: 'PLACED',
            signalId: signal.id,
            aiConfidence: signal.confidence,
            aiReasoning: signal.reasoning,
            placedAt: new Date(),
          },
        });
        
        // Update signal to APPROVED (not EXECUTED yet - that happens when order fills)
        const updated = await prisma.signal.update({
          where: { id },
          data: { status: 'APPROVED' },
        });
        
        // NOTE: Order sync happens automatically every minute via scheduler
        // No need to queue - just wait for the sync job to pick it up
        
        res.json({
          signal: updated,
          message: 'BUY order placed on Indodax! Waiting for order to be filled...',
          trade: {
            id: trade.id,
            orderId: tradeResult.order_id,
            pair: signal.pair,
            amount,
            cost,
            entryPrice,
            status: 'PLACED',
          },
        });
        return;
        
      } catch (tradeError: any) {
        console.error(`[Signal] Trade execution failed:`, tradeError.message);
        res.status(500).json({ 
          error: 'Failed to execute trade',
          message: tradeError.message,
        });
        return;
      }
    }
    
    // For HOLD signals (shouldn't happen)
    const updated = await prisma.signal.update({
      where: { id },
      data: { status },
    });
    
    res.json({ 
      signal: updated,
      message: 'Signal approved',
    });
    
  } catch (error) {
    console.error('Update signal error:', error);
    res.status(500).json({ error: 'Failed to update signal' });
  }
});

/**
 * POST /api/signals/analyze
 * Get market analysis without trading signal
 */
router.post('/analyze', validateBody(generateSignalSchema), async (req: AuthRequest, res) => {
  try {
    const { pair } = req.body;
    
    const analysis = await analyzeMarket(req.userId!, pair);
    const context = await getMarketContext(pair);
    
    res.json({
      pair,
      analysis,
      market: {
        price: context.currentPrice,
        high24h: context.high24h,
        low24h: context.low24h,
        volume24h: context.volume24h,
        change24h: context.change24h,
      },
    });
  } catch (error: any) {
    console.error('Analyze market error:', error);
    res.status(500).json({ error: error.message || 'Failed to analyze market' });
  }
});

/**
 * GET /api/signals/stats
 * Get signal performance stats
 */
router.get('/stats/summary', async (req: AuthRequest, res) => {
  try {
    const stats = await prisma.signal.groupBy({
      by: ['status', 'action'],
      where: { userId: req.userId },
      _count: true,
    });
    
    const trades = await prisma.trade.aggregate({
      where: { 
        userId: req.userId,
        signalId: { not: null },
        status: 'CLOSED',
      },
      _sum: { pnl: true },
      _count: true,
    });
    
    const profitableTrades = await prisma.trade.count({
      where: {
        userId: req.userId,
        signalId: { not: null },
        status: 'CLOSED',
        pnl: { gt: 0 },
      },
    });
    
    res.json({
      signalBreakdown: stats,
      trades: {
        total: trades._count,
        totalPnl: trades._sum.pnl?.toString() || '0',
        profitable: profitableTrades,
        winRate: trades._count > 0 
          ? ((profitableTrades / trades._count) * 100).toFixed(1) + '%'
          : 'N/A',
      },
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

export default router;
