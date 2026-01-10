import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { config } from '../config/index.js';
import prisma from '../config/database.js';
import { generateSignal } from '../services/ai.js';
import { sendSignalNotification, sendNotification } from '../services/websocket.js';
import { IndodaxPrivateAPI } from '../services/indodax.js';
import { decrypt } from '../utils/encryption.js';

// Redis connection options
const redisConnection = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  tls: config.redis.tls,
};

// ============== Queues ==============

// AI Analysis Queue
export const analysisQueue = new Queue('ai-analysis', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// Order Monitoring Queue
export const orderMonitorQueue = new Queue('order-monitor', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 3000,
    },
  },
});

// Notification Queue
export const notificationQueue = new Queue('notifications', {
  connection: redisConnection,
});

// Position Monitor Queue (for stop-loss/take-profit)
export const positionMonitorQueue = new Queue('position-monitor', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
});

// ============== Job Types ==============

interface AnalysisJobData {
  userId: string;
  pair: string;
  reason: 'scheduled' | 'manual' | 'trigger';
}

interface OrderMonitorJobData {
  userId: string;
  tradeId: string;
  orderId: string;
  pair: string;
  type: 'BUY' | 'SELL';
}

interface NotificationJobData {
  userId: string;
  type: string;
  title: string;
  message: string;
}

interface PositionMonitorJobData {
  trigger: boolean;
}

// ============== Workers ==============

/**
 * AI Analysis Worker
 * Processes scheduled and triggered analysis jobs
 */
export const analysisWorker = new Worker<AnalysisJobData>(
  'ai-analysis',
  async (job: Job<AnalysisJobData>) => {
    const { userId, pair, reason } = job.data || {};
    console.log(`[Job:Analysis] Processing ${pair} for user ${userId} (${reason})`);
    
    // Skip invalid jobs (stale jobs from old queue entries)
    if (!userId || !pair) {
      console.log(`[Job:Analysis] Skipping invalid job - missing userId or pair`);
      return { skipped: true, reason: 'invalid_job_data' };
    }
    
    try {
      // Get user settings
      const settings = await prisma.userSettings.findUnique({
        where: { userId },
      });
      
      if (!settings || !settings.botActive) {
        console.log(`[Job:Analysis] Bot not active for user ${userId}`);
        return { skipped: true, reason: 'bot_inactive' };
      }
      
      // Check if already have open position for this pair (skip BUY analysis)
      const existingPosition = await prisma.position.findFirst({
        where: {
          userId,
          pair,
          status: 'OPEN',
        },
      });
      
      if (existingPosition) {
        console.log(`[Job:Analysis] Already have open position for ${pair} - skipping BUY analysis`);
        return { skipped: true, reason: 'existing_position', positionId: existingPosition.id };
      }
      
      // Check total open positions limit
      const openPositionsCount = await prisma.position.count({
        where: {
          userId,
          status: 'OPEN',
        },
      });
      
      if (openPositionsCount >= settings.maxOpenPositions) {
        console.log(`[Job:Analysis] Max positions reached (${openPositionsCount}/${settings.maxOpenPositions}) - skipping`);
        return { skipped: true, reason: 'max_positions_reached' };
      }
      
      // Import news fetcher
      const { fetchCryptoNews } = await import('../services/news.js');
      const newsContext = await fetchCryptoNews(pair);
      
      // Generate signal (with scalping mode if enabled)
      const signal = await generateSignal({
        userId,
        pair,
        userRiskProfile: settings.riskProfile,
        newsContext,
        scalpingMode: settings.scalpingModeEnabled ? {
          enabled: true,
          takeProfitPct: settings.scalpingTakeProfitPct,
          stopLossPct: settings.scalpingStopLossPct,
          maxHoldMins: settings.scalpingMaxHoldMins,
        } : undefined,
      });
      
      if (!signal) {
        return { skipped: true, reason: 'no_signal' };
      }
      
      // HOLD signals are not saved - no action needed
      if (signal.action === 'HOLD') {
        console.log(`[Job:Analysis] HOLD signal for ${pair} - skipping`);
        return { skipped: true, reason: 'hold_signal', confidence: signal.confidence };
      }
      
      // Check minimum confidence
      if (signal.confidence < settings.minConfidenceToTrade) {
        console.log(`[Job:Analysis] Confidence ${(signal.confidence * 100).toFixed(1)}% below threshold ${(settings.minConfidenceToTrade * 100).toFixed(1)}%`);
        
        // Save as SKIPPED signal
        await prisma.signal.create({
          data: {
            userId,
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
            newsContext,
            status: 'SKIPPED',
            validUntil: new Date(Date.now() + 60 * 60 * 1000),
          },
        });
        
        return { skipped: true, reason: 'low_confidence', confidence: signal.confidence };
      }
      
      // Determine status based on trading mode
      const signalStatus = settings.tradingMode === 'AUTONOMOUS' ? 'APPROVED' : 'PENDING';
      
      // Save signal to database
      const savedSignal = await prisma.signal.create({
        data: {
          userId,
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
          newsContext,
          status: signalStatus,
          validUntil: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      
      // Send notification
      sendSignalNotification(userId, {
        id: savedSignal.id,
        pair,
        action: signal.action,
        confidence: signal.confidence,
        status: savedSignal.status,
        reasoning: signal.reasoning,
        createdAt: savedSignal.createdAt.toISOString(),
      });
      
      // If autonomous mode with BUY/SELL signal, execute trade
      if (settings.tradingMode === 'AUTONOMOUS' && signal.action !== 'HOLD') {
        console.log(`[Job:Analysis] AUTONOMOUS mode - executing trade for signal ${savedSignal.id}`);
        
        // Import position service
        const { openPosition, closePosition, getBotPositionAmount, findPositionToClose } = await import('../services/position.js');
        
        if (signal.action === 'SELL') {
          // Check if we have positions to sell
          const botAmount = await getBotPositionAmount(userId, pair);
          
          if (botAmount === 0) {
            console.log(`[Job:Analysis] No bot positions to sell for ${pair}`);
            await prisma.signal.update({
              where: { id: savedSignal.id },
              data: { status: 'SKIPPED' },
            });
            return { skipped: true, reason: 'no_positions_to_sell' };
          }
          
          // Find and close position
          const positionToClose = await findPositionToClose(userId, pair);
          if (positionToClose) {
            const closedPosition = await closePosition({
              positionId: positionToClose.id,
              exitPrice: signal.entryPrice,
              reason: 'SIGNAL',
            });
            
            await prisma.signal.update({
              where: { id: savedSignal.id },
              data: { status: 'EXECUTED' },
            });
            
            // Notify about closed position
            await notificationQueue.add('send', {
              userId,
              type: 'TRADE',
              title: `Position Closed - ${pair.toUpperCase()}`,
              message: `P&L: ${Number(closedPosition.pnl).toFixed(2)} IDR (${closedPosition.pnlPercent?.toFixed(2)}%)`,
            });
            
            return {
              success: true,
              signalId: savedSignal.id,
              action: 'SELL',
              positionClosed: positionToClose.id,
              pnl: Number(closedPosition.pnl),
            };
          }
        }
        
        if (signal.action === 'BUY') {
          // Calculate amount based on settings (simplified - assume 10M IDR balance)
          const estimatedBalance = 10000000; // TODO: Get real balance from Indodax
          const cost = (estimatedBalance * signal.amountPercent) / 100;
          const amount = cost / signal.entryPrice;
          
          // Open position
          const position = await openPosition({
            userId,
            pair,
            amount,
            entryPrice: signal.entryPrice,
            cost,
            signalId: savedSignal.id,
            stopLoss: signal.stopLoss,
            takeProfit: signal.targetPrice,
          });
          
          await prisma.signal.update({
            where: { id: savedSignal.id },
            data: { status: 'EXECUTED' },
          });
          
          // Notify about opened position
          await notificationQueue.add('send', {
            userId,
            type: 'TRADE',
            title: `Position Opened - ${pair.toUpperCase()}`,
            message: `Bought ${amount.toFixed(4)} @ ${signal.entryPrice.toLocaleString('id-ID')} IDR`,
          });
          
          return {
            success: true,
            signalId: savedSignal.id,
            action: 'BUY',
            positionOpened: position.id,
            amount,
            cost,
          };
        }
      }
      
      return { 
        success: true, 
        signalId: savedSignal.id,
        action: signal.action,
        confidence: signal.confidence,
        mode: settings.tradingMode,
      };
    } catch (error: any) {
      console.error(`[Job:Analysis] Error:`, error.message);
      throw error;
    }
  },
  { connection: redisConnection, concurrency: 2 }
);

/**
 * Order Monitor Worker
 * Checks order status and updates database
 */
export const orderMonitorWorker = new Worker<OrderMonitorJobData>(
  'order-monitor',
  async (job: Job<OrderMonitorJobData>) => {
    const { userId, tradeId, orderId, pair, type } = job.data;
    console.log(`[Job:OrderMonitor] Checking order ${orderId} for trade ${tradeId}`);
    
    try {
      // Get user API keys
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { indodaxApiKey: true, indodaxSecretKey: true },
      });
      
      if (!user?.indodaxApiKey || !user?.indodaxSecretKey) {
        throw new Error('API keys not configured');
      }
      
      const api = new IndodaxPrivateAPI(
        decrypt(user.indodaxApiKey),
        decrypt(user.indodaxSecretKey)
      );
      
      // Get order details
      const orderResult = await api.getOrder(pair, parseInt(orderId));
      const order = orderResult.order as any;
      
      // Map Indodax status to our status
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
      
      // Calculate filled amount
      const totalOrder = parseFloat(order.order_idr || order[pair.split('_')[0]] || '0');
      const remainOrder = parseFloat(order.remain_idr || order.remain || '0');
      const filledAmount = totalOrder > 0 && remainOrder >= 0 ? totalOrder - remainOrder : 0;
      
      // Update trade in database
      const trade = await prisma.trade.update({
        where: { id: tradeId },
        data: {
          status: newStatus as any,
          filledAmount,
        },
      });
      
      // If still pending, re-queue for monitoring
      if (newStatus === 'PLACED' || newStatus === 'PARTIAL') {
        await orderMonitorQueue.add(
          'check-order',
          job.data,
          { delay: 30000 } // Check again in 30 seconds
        );
      } else {
        // Send notification about completed order
        await notificationQueue.add('send', {
          userId,
          type: 'TRADE',
          title: `Order ${newStatus}`,
          message: `Your ${type} order for ${pair} has been ${newStatus.toLowerCase()}.`,
        });
      }
      
      return { status: newStatus, tradeId };
    } catch (error: any) {
      console.error(`[Job:OrderMonitor] Error:`, error.message);
      throw error;
    }
  },
  { connection: redisConnection, concurrency: 5 }
);

/**
 * Notification Worker
 * Sends notifications to users
 */
export const notificationWorker = new Worker<NotificationJobData>(
  'notifications',
  async (job: Job<NotificationJobData>) => {
    const { userId, type, title, message } = job.data;
    
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
      
      // TODO: Send push notification / email if enabled
      
      return { notificationId: notification.id };
    } catch (error: any) {
      console.error(`[Job:Notification] Error:`, error.message);
      throw error;
    }
  },
  { connection: redisConnection, concurrency: 10 }
);

/**
 * Position Monitor Worker
 * Checks all open positions for stop-loss and take-profit triggers
 */
export const positionMonitorWorker = new Worker<PositionMonitorJobData>(
  'position-monitor',
  async (job: Job<PositionMonitorJobData>) => {
    console.log('[Job:PositionMonitor] Checking all open positions...');
    
    try {
      const { getOpenPositions, closePosition, checkExitConditions } = await import('../services/position.js');
      const { indodaxPublicAPI } = await import('../services/indodax.js');
      
      // Get current market prices
      const summaries = await indodaxPublicAPI.getSummaries();
      
      // Get all open positions across all users
      const openPositions = await prisma.position.findMany({
        where: { status: 'OPEN' },
        include: { user: { select: { id: true } } },
      });
      
      console.log(`[Job:PositionMonitor] Found ${openPositions.length} open positions`);
      
      let closedCount = 0;
      
      for (const position of openPositions) {
        const pairKey = position.pair.toLowerCase();
        const ticker = summaries.tickers[pairKey];
        
        if (!ticker) {
          console.log(`[Job:PositionMonitor] No ticker found for ${position.pair}`);
          continue;
        }
        
        const currentPrice = parseFloat(ticker.last);
        const entryPrice = Number(position.entryPrice);
        const stopLoss = position.stopLoss ? Number(position.stopLoss) : null;
        const takeProfit = position.takeProfit ? Number(position.takeProfit) : null;
        const pnlPercent = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(2);
        
        // Log current price and status for each position
        console.log(`[Job:PositionMonitor] 📊 ${position.pair.toUpperCase()}`);
        console.log(`  Entry: ${entryPrice} | Current: ${currentPrice} | PnL: ${pnlPercent}%`);
        console.log(`  SL: ${stopLoss || 'N/A'} | TP: ${takeProfit || 'N/A'}`);
        console.log(`  SL Hit: ${stopLoss && currentPrice <= stopLoss ? '⚠️ YES' : 'No'} | TP Hit: ${takeProfit && currentPrice >= takeProfit ? '🎯 YES' : 'No'}`);
        
        const exitCheck = checkExitConditions(position, currentPrice);
        
        if (exitCheck.shouldClose && exitCheck.reason) {
          console.log(`[Job:PositionMonitor] ${exitCheck.reason} triggered for position ${position.id}`);
          
          try {
            // Get user's Indodax API keys
            const user = await prisma.user.findUnique({
              where: { id: position.userId },
              select: { indodaxApiKey: true, indodaxSecretKey: true },
            });
            
            if (!user?.indodaxApiKey || !user?.indodaxSecretKey) {
              console.log(`[Job:PositionMonitor] No API keys for user ${position.userId}, skipping execution`);
              continue;
            }
            
            // Create Indodax API client
            const apiKey = decrypt(user.indodaxApiKey);
            const secretKey = decrypt(user.indodaxSecretKey);
            const api = new IndodaxPrivateAPI(apiKey, secretKey);
            
            // Execute SELL order on Indodax
            const sellAmount = Math.floor(Number(position.amount)); // Integer for Indodax
            console.log(`[Job:PositionMonitor] Executing SELL: ${sellAmount} ${position.pair} @ ${currentPrice}`);
            
            const tradeResult = await api.trade({
              pair: position.pair,
              type: 'sell',
              price: currentPrice,
              amount: sellAmount,
              orderType: 'limit',
            });
            
            console.log(`[Job:PositionMonitor] SELL order placed: ${tradeResult.order_id}`);
            
            // Close position in database
            const closedPosition = await closePosition({
              positionId: position.id,
              exitPrice: currentPrice,
              reason: exitCheck.reason,
            });
            
            // Send notification
            await notificationQueue.add('send', {
              userId: position.userId,
              type: 'TRADE',
              title: `${exitCheck.reason.replace('_', ' ')} - ${position.pair.toUpperCase()}`,
              message: `Position closed @ ${currentPrice.toLocaleString('id-ID')} IDR. P&L: ${Number(closedPosition.pnl).toFixed(2)} IDR (${closedPosition.pnlPercent?.toFixed(2)}%)`,
            });
            
            closedCount++;
          } catch (tradeError: any) {
            console.error(`[Job:PositionMonitor] Failed to execute SELL for position ${position.id}:`, tradeError.message);
            // Continue checking other positions, don't throw
          }
        }
      }
      
      return { 
        positionsChecked: openPositions.length,
        positionsClosed: closedCount,
      };
    } catch (error: any) {
      console.error('[Job:PositionMonitor] Error:', error.message);
      throw error;
    }
  },
  { connection: redisConnection, concurrency: 1 }
);

// ============== Schedulers ==============

/**
 * Schedule periodic AI analysis for all active users
 */
export async function schedulePeriodicAnalysis(): Promise<void> {
  // Get all users with active bots
  const activeUsers = await prisma.userSettings.findMany({
    where: { botActive: true },
    include: { user: true },
  });
  
  console.log(`[Scheduler] Found ${activeUsers.length} active users`);
  
  for (const settings of activeUsers) {
    const pairs = settings.allowedPairs.length > 0 
      ? settings.allowedPairs 
      : ['btc_idr', 'eth_idr']; // Default pairs
    
    for (const pair of pairs) {
      await analysisQueue.add(
        'scheduled-analysis',
        {
          userId: settings.userId,
          pair,
          reason: 'scheduled',
        },
        {
          jobId: `analysis_${settings.userId}_${pair}_${Date.now()}`,
        }
      );
    }
  }
}

/**
 * Start repeating jobs
 */
// Track last analysis time per user (in memory)
const lastAnalysisTime: Map<string, number> = new Map();

export async function startScheduledJobs(): Promise<void> {
  console.log('[Scheduler] Initializing scheduled jobs...');
  
  // Clean up old repeating jobs first
  try {
    const repeatableJobs = await analysisQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      console.log(`[Scheduler] Removing old repeating job: ${job.key}`);
      await analysisQueue.removeRepeatableByKey(job.key);
    }
    
    // Also obliterate old stale jobs
    await analysisQueue.obliterate({ force: true });
    console.log('[Scheduler] Cleaned up old analysis jobs');
  } catch (err) {
    console.log('[Scheduler] Could not clean up old jobs:', err);
  }
  
  // Run initial analysis immediately for all active users
  await schedulePeriodicAnalysis();
  
  // Mark initial analysis time for all users
  const activeUsers = await prisma.userSettings.findMany({
    where: { botActive: true },
  });
  for (const settings of activeUsers) {
    lastAnalysisTime.set(settings.userId, Date.now());
  }
  
  // Set up interval to check and schedule analysis every minute
  // Each user's actual analysis frequency is controlled by their settings
  setInterval(async () => {
    try {
      // Get all users with active bots
      const users = await prisma.userSettings.findMany({
        where: { botActive: true },
        include: { user: true },
      });
      
      const now = Date.now();
      
      for (const settings of users) {
        // Check if enough time has passed since last analysis based on user's interval
        const intervalMs = (settings.analysisIntervalMins || 15) * 60 * 1000;
        const lastTime = lastAnalysisTime.get(settings.userId) || 0;
        const timeSinceLastAnalysis = now - lastTime;
        
        if (timeSinceLastAnalysis >= intervalMs) {
          console.log(`[Scheduler] Running analysis for user ${settings.userId} (interval: ${settings.analysisIntervalMins}min, elapsed: ${Math.round(timeSinceLastAnalysis / 60000)}min)`);
          
          // Update last analysis time BEFORE running analysis
          lastAnalysisTime.set(settings.userId, now);
          
          const pairs = settings.allowedPairs.length > 0 
            ? settings.allowedPairs 
            : ['btc_idr', 'eth_idr'];
          
          for (const pair of pairs) {
            await analysisQueue.add(
              'scheduled-analysis',
              {
                userId: settings.userId,
                pair,
                reason: 'scheduled',
              },
              {
                jobId: `analysis_${settings.userId}_${pair}_${now}`,
              }
            );
          }
        }
      }
    } catch (error) {
      console.error('[Scheduler] Error in periodic check:', error);
    }
  }, 60000); // Check every minute
  
  // Schedule position monitoring every minute
  await positionMonitorQueue.add(
    'position-check',
    { trigger: true },
    {
      repeat: {
        pattern: '* * * * *', // Every minute
      },
      jobId: 'position-monitor-scheduler',
    }
  );
  
  console.log('[Scheduler] Scheduled jobs started');
  console.log('[Scheduler] - AI Analysis: per-user interval (checking every minute)');
  console.log('[Scheduler] - Position Monitor: every minute');
}

// ============== Event Handlers ==============

// Queue events for monitoring
const analysisEvents = new QueueEvents('ai-analysis', { connection: redisConnection });

analysisEvents.on('completed', ({ jobId, returnvalue }) => {
  console.log(`[Job:Analysis] Completed: ${jobId}`, returnvalue);
});

analysisEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`[Job:Analysis] Failed: ${jobId}`, failedReason);
});

const positionEvents = new QueueEvents('position-monitor', { connection: redisConnection });

positionEvents.on('completed', ({ jobId, returnvalue }) => {
  console.log(`[Job:PositionMonitor] Completed: ${jobId}`, returnvalue);
});

// ============== Cleanup ==============

export async function closeQueues(): Promise<void> {
  await analysisQueue.close();
  await orderMonitorQueue.close();
  await notificationQueue.close();
  await positionMonitorQueue.close();
  await analysisWorker.close();
  await orderMonitorWorker.close();
  await notificationWorker.close();
  await positionMonitorWorker.close();
  console.log('[Jobs] All queues closed');
}
