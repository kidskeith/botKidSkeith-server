/**
 * Simple Scheduler - No Redis Required
 * Replaces BullMQ with setInterval-based scheduling
 */
import prisma from '../config/database.js';
import { sendSignalNotification, sendNotification } from '../services/websocket.js';
import { IndodaxPrivateAPI, indodaxPublicAPI } from '../services/indodax.js';
import { decrypt } from '../utils/encryption.js';
import { generateSignal } from '../services/ai.js';
import { openPosition, closePosition, checkExitConditions } from '../services/position.js';

// Track last analysis time per user (in memory)
const lastAnalysisTime: Map<string, number> = new Map();

// Running status
let isRunning = false;
let positionMonitorInterval: NodeJS.Timeout | null = null;
let orderSyncInterval: NodeJS.Timeout | null = null;
let analysisInterval: NodeJS.Timeout | null = null;

/**
 * Send notification and save to database
 */
export async function sendAndSaveNotification(
  userId: string,
  type: string,
  title: string,
  message: string
): Promise<void> {
  try {
    // Save notification to database
    const notification = await prisma.notification.create({
      data: {
        userId,
        type: type as any,
        title,
        message,
        data: {},
      },
    });
    
    // Send via WebSocket
    sendNotification(userId, {
      id: notification.id,
      type,
      title,
      message,
      createdAt: notification.createdAt.toISOString(),
    });
  } catch (error: any) {
    console.error(`[Notification] Error:`, error.message);
  }
}

/**
 * Check all open positions for SL/TP triggers
 * Runs every 1 minute
 */
export async function checkPositionsForSLTP(): Promise<void> {
  console.log('[PositionMonitor] Checking all open positions...');
  
  try {
    // Get current market prices
    const summaries = await indodaxPublicAPI.getSummaries();
    
    // Get all open positions across all users
    const openPositions = await prisma.position.findMany({
      where: { status: 'OPEN' },
      include: { user: { select: { id: true, indodaxApiKey: true, indodaxSecretKey: true } } },
    });
    
    console.log(`[PositionMonitor] Found ${openPositions.length} open positions`);
    
    for (const position of openPositions) {
      const pairKey = position.pair.toLowerCase();
      const ticker = summaries.tickers[pairKey];
      
      if (!ticker) {
        continue;
      }
      
      const currentPrice = parseFloat(ticker.last);
      const entryPrice = Number(position.entryPrice);
      const stopLoss = position.stopLoss ? Number(position.stopLoss) : null;
      const takeProfit = position.takeProfit ? Number(position.takeProfit) : null;
      const pnlPercent = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(2);
      
      // Log status
      console.log(`[PositionMonitor] 📊 ${position.pair.toUpperCase()} | Current: ${currentPrice} | PnL: ${pnlPercent}%`);
      
      const exitCheck = checkExitConditions(position, currentPrice);
      
      if (exitCheck.shouldClose && exitCheck.reason) {
        console.log(`[PositionMonitor] ${exitCheck.reason} triggered for position ${position.id}`);
        
        try {
          const user = position.user;
          if (!user?.indodaxApiKey || !user?.indodaxSecretKey) {
            console.log(`[PositionMonitor] No API keys for user, skipping`);
            continue;
          }
          
          // Create Indodax API client
          const api = new IndodaxPrivateAPI(
            decrypt(user.indodaxApiKey),
            decrypt(user.indodaxSecretKey)
          );
          
          // Execute SELL order
          const sellAmount = Math.floor(Number(position.amount));
          console.log(`[PositionMonitor] Executing SELL: ${sellAmount} ${position.pair} @ ${currentPrice}`);
          
          const tradeResult = await api.trade({
            pair: position.pair,
            type: 'sell',
            price: currentPrice,
            amount: sellAmount,
            orderType: 'limit',
          });
          
          console.log(`[PositionMonitor] SELL order placed: ${tradeResult.order_id}`);
          
          // Close position in database
          const closedPosition = await closePosition({
            positionId: position.id,
            exitPrice: currentPrice,
            reason: exitCheck.reason,
          });
          
          // Send notification
          await sendAndSaveNotification(
            position.userId,
            'TRADE',
            `${exitCheck.reason.replace('_', ' ')} - ${position.pair.toUpperCase()}`,
            `Position closed @ ${currentPrice.toLocaleString('id-ID')} IDR. P&L: ${Number(closedPosition.pnl).toFixed(2)} IDR (${closedPosition.pnlPercent?.toFixed(2)}%)`
          );
        } catch (tradeError: any) {
          console.error(`[PositionMonitor] Failed to execute SELL:`, tradeError.message);
        }
      }
    }
  } catch (error: any) {
    console.error('[PositionMonitor] Error:', error.message);
  }
}

/**
 * Sync all PLACED orders with Indodax
 * Runs every 1 minute
 */
export async function syncPendingOrders(): Promise<void> {
  console.log('[OrderSync] Syncing pending orders...');
  
  try {
    // Get all trades with PLACED status grouped by user
    const pendingTrades = await prisma.trade.findMany({
      where: {
        status: { in: ['PLACED', 'PARTIAL'] },
        orderId: { not: null },
      },
      include: {
        user: {
          select: { id: true, indodaxApiKey: true, indodaxSecretKey: true },
        },
      },
    });
    
    if (pendingTrades.length === 0) {
      console.log('[OrderSync] No pending orders to sync');
      return;
    }
    
    console.log(`[OrderSync] Found ${pendingTrades.length} pending orders`);
    
    for (const trade of pendingTrades) {
      try {
        const user = trade.user;
        if (!user?.indodaxApiKey || !user?.indodaxSecretKey) {
          continue;
        }
        
        const api = new IndodaxPrivateAPI(
          decrypt(user.indodaxApiKey),
          decrypt(user.indodaxSecretKey)
        );
        
        // Get order status from Indodax
        const orderResult = await api.getOrder(trade.pair, parseInt(trade.orderId!));
        const order = orderResult.order as any;
        
        // Determine new status
        let newStatus: string;
        const orderStatus = order.status || (order.remain_idr === '0' ? 'filled' : 'open');
        
        switch (orderStatus) {
          case 'filled':
            newStatus = 'FILLED';
            break;
          case 'partial':
            newStatus = 'PARTIAL';
            break;
          case 'cancelled':
            newStatus = 'CANCELLED';
            break;
          default:
            newStatus = 'PLACED';
        }
        
        // Update trade if status changed
        if (newStatus !== trade.status) {
          console.log(`[OrderSync] Trade ${trade.id}: ${trade.status} -> ${newStatus}`);
          
          await prisma.trade.update({
            where: { id: trade.id },
            data: {
              status: newStatus as any,
              filledAt: newStatus === 'FILLED' ? new Date() : undefined,
            },
          });
          
          // If BUY order is now FILLED, create position
          if (newStatus === 'FILLED' && trade.type === 'BUY') {
            const existingPosition = await prisma.position.findFirst({
              where: {
                userId: trade.userId,
                entryTradeId: trade.orderId,
              },
            });
            
            if (!existingPosition) {
              console.log(`[OrderSync] Creating position for filled BUY: ${trade.pair}`);
              
              await openPosition({
                userId: trade.userId,
                pair: trade.pair,
                amount: Number(trade.amount),
                entryPrice: Number(trade.price),
                cost: Number(trade.cost),
                signalId: trade.signalId || undefined,
                stopLoss: trade.stopLoss ? Number(trade.stopLoss) : undefined,
                takeProfit: trade.takeProfit ? Number(trade.takeProfit) : undefined,
                entryTradeId: trade.orderId!,
              });
              
              // Update signal to EXECUTED
              if (trade.signalId) {
                await prisma.signal.update({
                  where: { id: trade.signalId },
                  data: { status: 'EXECUTED' },
                });
              }
              
              // Notify user
              await sendAndSaveNotification(
                trade.userId,
                'TRADE',
                `✅ BUY Order Filled - ${trade.pair.toUpperCase()}`,
                `Position opened at ${Number(trade.price).toLocaleString('id-ID')} IDR.`
              );
            }
          }
        }
      } catch (tradeError: any) {
        console.error(`[OrderSync] Error syncing trade ${trade.id}:`, tradeError.message);
      }
    }
  } catch (error: any) {
    console.error('[OrderSync] Error:', error.message);
  }
}

/**
 * Run AI analysis for active users
 */
export async function runScheduledAnalysis(): Promise<void> {
  console.log('[Analysis] Running scheduled analysis...');
  
  try {
    // Get all users with active bots
    const activeUsers = await prisma.userSettings.findMany({
      where: { botActive: true },
      include: { user: true },
    });
    
    if (activeUsers.length === 0) {
      console.log('[Analysis] No active users');
      return;
    }
    
    console.log(`[Analysis] Found ${activeUsers.length} active users`);
    
    for (const settings of activeUsers) {
      // Rate limit per user
      const now = Date.now();
      const lastRun = lastAnalysisTime.get(settings.userId) || 0;
      const minInterval = (settings.analysisIntervalMins || 30) * 60 * 1000;
      
      if (now - lastRun < minInterval) {
        console.log(`[Analysis] Skipping user ${settings.userId} (rate limited)`);
        continue;
      }
      
      // Pick a random pair from allowed pairs
      const pairs = settings.allowedPairs.length > 0 
        ? settings.allowedPairs 
        : ['btc_idr', 'eth_idr'];
      
      const pair = pairs[Math.floor(Math.random() * pairs.length)];
      console.log(`[Analysis] Analyzing ${pair} for user ${settings.userId}`);
      
      try {
        // Check position limits
        const openPositionsCount = await prisma.position.count({
          where: { userId: settings.userId, status: 'OPEN' },
        });
        
        if (openPositionsCount >= settings.maxOpenPositions) {
          console.log(`[Analysis] Max positions reached for user`);
          continue;
        }
        
        // Check existing position for this pair
        const existingPosition = await prisma.position.findFirst({
          where: { userId: settings.userId, pair, status: 'OPEN' },
        });
        
        if (existingPosition) {
          console.log(`[Analysis] Position already open for ${pair}`);
          continue;
        }
        
        // Generate signal
        const signal = await generateSignal({
          userId: settings.userId,
          pair,
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
        
        if (!signal || signal.action === 'HOLD') {
          console.log(`[Analysis] No action for ${pair}`);
          lastAnalysisTime.set(settings.userId, now);
          continue;
        }
        
        if (signal.confidence < settings.minConfidenceToTrade) {
          console.log(`[Analysis] Confidence too low: ${signal.confidence}`);
          lastAnalysisTime.set(settings.userId, now);
          continue;
        }
        
        // Save signal
        const savedSignal = await prisma.signal.create({
          data: {
            userId: settings.userId,
            pair,
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
        
        console.log(`[Analysis] Signal created: ${savedSignal.id} - ${signal.action}`);
        
        // Send notification via WebSocket
        sendSignalNotification(settings.userId, {
          id: savedSignal.id,
          pair,
          action: signal.action,
          confidence: signal.confidence,
          status: 'PENDING',
          reasoning: signal.reasoning,
          createdAt: savedSignal.createdAt.toISOString(),
        });
        
        lastAnalysisTime.set(settings.userId, now);
        
      } catch (analysisError: any) {
        console.error(`[Analysis] Error for user ${settings.userId}:`, analysisError.message);
      }
    }
  } catch (error: any) {
    console.error('[Analysis] Error:', error.message);
  }
}

/**
 * Start all scheduled jobs
 */
export function startScheduler(): void {
  if (isRunning) {
    console.log('[Scheduler] Already running');
    return;
  }
  
  console.log('[Scheduler] Starting scheduled jobs (no Redis)...');
  isRunning = true;
  
  // Position Monitor - every 1 minute
  checkPositionsForSLTP(); // Run immediately
  positionMonitorInterval = setInterval(checkPositionsForSLTP, 60 * 1000);
  console.log('[Scheduler] ✓ Position Monitor: every 1 minute');
  
  // Order Sync - every 1 minute
  syncPendingOrders(); // Run immediately
  orderSyncInterval = setInterval(syncPendingOrders, 60 * 1000);
  console.log('[Scheduler] ✓ Order Sync: every 1 minute');
  
  // AI Analysis - every 5 minutes
  analysisInterval = setInterval(runScheduledAnalysis, 5 * 60 * 1000);
  console.log('[Scheduler] ✓ AI Analysis: every 5 minutes');
  
  console.log('[Scheduler] All jobs started!');
}

/**
 * Stop all scheduled jobs
 */
export function stopScheduler(): void {
  console.log('[Scheduler] Stopping scheduled jobs...');
  
  if (positionMonitorInterval) {
    clearInterval(positionMonitorInterval);
    positionMonitorInterval = null;
  }
  
  if (orderSyncInterval) {
    clearInterval(orderSyncInterval);
    orderSyncInterval = null;
  }
  
  if (analysisInterval) {
    clearInterval(analysisInterval);
    analysisInterval = null;
  }
  
  isRunning = false;
  console.log('[Scheduler] All jobs stopped');
}

/**
 * Check if scheduler is running
 */
export function isSchedulerRunning(): boolean {
  return isRunning;
}
