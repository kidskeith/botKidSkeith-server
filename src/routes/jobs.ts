import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { isSchedulerRunning, runScheduledAnalysis, checkPositionsForSLTP, syncPendingOrders } from '../services/scheduler.js';
import { generateSignal } from '../services/ai.js';
import prisma from '../config/database.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/jobs/status
 * Get scheduler status (no more queues)
 */
router.get('/status', async (req: AuthRequest, res) => {
  try {
    const isRunning = isSchedulerRunning();
    
    // Get counts from database instead of queues
    const [pendingSignals, openPositions, pendingTrades] = await Promise.all([
      prisma.signal.count({ where: { status: 'PENDING' } }),
      prisma.position.count({ where: { status: 'OPEN' } }),
      prisma.trade.count({ where: { status: 'PLACED' } }),
    ]);
    
    res.json({
      scheduler: {
        running: isRunning,
        type: 'setInterval (no Redis)',
      },
      stats: {
        pendingSignals,
        openPositions,
        pendingTrades,
      },
    });
  } catch (error) {
    console.error('Get job status error:', error);
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

/**
 * POST /api/jobs/analyze
 * Trigger immediate analysis for user's pairs
 */
router.post('/analyze', async (req: AuthRequest, res) => {
  try {
    const { pair } = req.body;
    
    // Get user settings
    const settings = await prisma.userSettings.findUnique({
      where: { userId: req.userId! },
    });
    
    if (!settings) {
      res.status(400).json({ error: 'User settings not found' });
      return;
    }
    
    const targetPair = pair || (settings.allowedPairs.length > 0 ? settings.allowedPairs[0] : 'btc_idr');
    
    // Generate signal directly (no queue)
    const signal = await generateSignal({
      userId: req.userId!,
      pair: targetPair,
      userRiskProfile: settings.riskProfile,
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
    
    if (!signal) {
      res.json({ message: 'No signal generated', pair: targetPair });
      return;
    }
    
    // Save signal
    const savedSignal = await prisma.signal.create({
      data: {
        userId: req.userId!,
        pair: targetPair,
        action: signal.action,
        confidence: signal.confidence,
        technicalScore: signal.technicalScore,
        sentimentScore: signal.sentimentScore,
        riskScore: signal.riskScore,
        entryPrice: signal.entryPrice,
        targetPrice: signal.targetPrice,
        stopLoss: signal.stopLoss,
        amountPercent: signal.amountPercent,
        reasoning: signal.reasoning,
        status: 'PENDING',
        validUntil: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    
    res.json({
      message: 'Analysis complete',
      signal: savedSignal,
    });
  } catch (error: any) {
    console.error('Analyze error:', error);
    res.status(500).json({ error: error.message || 'Failed to analyze' });
  }
});

/**
 * POST /api/jobs/scheduler/trigger
 * Trigger scheduled tasks manually
 */
router.post('/scheduler/trigger', async (req: AuthRequest, res) => {
  try {
    const { task } = req.body;
    
    switch (task) {
      case 'analysis':
        await runScheduledAnalysis();
        res.json({ message: 'Analysis triggered' });
        break;
      case 'positions':
        await checkPositionsForSLTP();
        res.json({ message: 'Position check triggered' });
        break;
      case 'orders':
        await syncPendingOrders();
        res.json({ message: 'Order sync triggered' });
        break;
      default:
        res.status(400).json({ error: 'Invalid task. Use: analysis, positions, orders' });
    }
  } catch (error: any) {
    console.error('Trigger scheduler error:', error);
    res.status(500).json({ error: error.message || 'Failed to trigger scheduler' });
  }
});

/**
 * GET /api/jobs/history
 * Get recent signals for current user (replaces queue history)
 */
router.get('/history', async (req: AuthRequest, res) => {
  try {
    const { limit = 20 } = req.query;
    
    const recentSignals = await prisma.signal.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
    });
    
    res.json({
      signals: recentSignals.map(signal => ({
        id: signal.id,
        pair: signal.pair,
        action: signal.action,
        confidence: signal.confidence,
        status: signal.status,
        createdAt: signal.createdAt,
      })),
    });
  } catch (error) {
    console.error('Get job history error:', error);
    res.status(500).json({ error: 'Failed to get job history' });
  }
});

export default router;
