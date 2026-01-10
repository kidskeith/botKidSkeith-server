import prisma from '../config/database.js';

// Types
export interface OpenPositionParams {
  userId: string;
  pair: string;
  amount: number;
  entryPrice: number;
  cost: number;
  signalId?: string;
  stopLoss?: number;
  takeProfit?: number;
  entryTradeId?: string;
}

export interface ClosePositionParams {
  positionId: string;
  exitPrice: number;
  exitAmount?: number;
  reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL' | 'SIGNAL';
  exitTradeId?: string;
}

/**
 * Open a new position (track a BUY from bot)
 */
export async function openPosition(params: OpenPositionParams) {
  const { userId, pair, amount, entryPrice, cost, signalId, stopLoss, takeProfit, entryTradeId } = params;
  
  const position = await prisma.position.create({
    data: {
      userId,
      pair,
      amount,
      entryPrice,
      cost,
      stopLoss: stopLoss || undefined,
      takeProfit: takeProfit || undefined,
      signalId,
      entryTradeId,
      status: 'OPEN',
    },
  });
  
  console.log(`[Position] Opened position for ${pair}: ${amount} @ ${entryPrice}`);
  return position;
}

/**
 * Close an existing position (track a SELL from bot)
 */
export async function closePosition(params: ClosePositionParams) {
  const { positionId, exitPrice, exitAmount, reason, exitTradeId } = params;
  
  const position = await prisma.position.findUnique({
    where: { id: positionId },
  });
  
  if (!position) {
    throw new Error(`Position not found: ${positionId}`);
  }
  
  const entryPriceNum = Number(position.entryPrice);
  const amount = exitAmount || Number(position.amount);
  
  // Calculate P&L
  const exitValue = amount * exitPrice;
  const entryValue = amount * entryPriceNum;
  const pnl = exitValue - entryValue;
  const pnlPercent = ((exitPrice - entryPriceNum) / entryPriceNum) * 100;
  
  const updated = await prisma.position.update({
    where: { id: positionId },
    data: {
      status: exitAmount && exitAmount < Number(position.amount) ? 'PARTIALLY_CLOSED' : 'CLOSED',
      exitPrice,
      exitAmount: amount,
      pnl,
      pnlPercent,
      closedAt: new Date(),
      closeReason: reason,
      exitTradeId,
    },
  });
  
  console.log(`[Position] Closed position ${positionId}: ${reason}, P&L: ${pnl.toFixed(2)} IDR (${pnlPercent.toFixed(2)}%)`);
  return updated;
}

/**
 * Get all open positions for a user (optionally filtered by pair)
 */
export async function getOpenPositions(userId: string, pair?: string) {
  return prisma.position.findMany({
    where: {
      userId,
      status: 'OPEN',
      ...(pair && { pair }),
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Get total amount of coin held in bot positions for a pair
 * This is the MAXIMUM amount the bot can sell (user's original holdings are protected)
 */
export async function getBotPositionAmount(userId: string, pair: string): Promise<number> {
  const positions = await getOpenPositions(userId, pair);
  
  return positions.reduce((total, pos) => total + Number(pos.amount), 0);
}

/**
 * Find the best position to close (oldest or by specified criteria)
 */
export async function findPositionToClose(userId: string, pair: string) {
  const positions = await getOpenPositions(userId, pair);
  
  if (positions.length === 0) {
    return null;
  }
  
  // Return oldest position (FIFO - First In, First Out)
  return positions[positions.length - 1];
}

/**
 * Check if price has hit stop loss or take profit
 */
export function checkExitConditions(
  position: { stopLoss?: any; takeProfit?: any; entryPrice?: any },
  currentPrice: number
): { shouldClose: boolean; reason?: 'TAKE_PROFIT' | 'STOP_LOSS' } {
  const stopLoss = position.stopLoss ? Number(position.stopLoss) : null;
  const takeProfit = position.takeProfit ? Number(position.takeProfit) : null;
  
  if (stopLoss && currentPrice <= stopLoss) {
    return { shouldClose: true, reason: 'STOP_LOSS' };
  }
  
  if (takeProfit && currentPrice >= takeProfit) {
    return { shouldClose: true, reason: 'TAKE_PROFIT' };
  }
  
  return { shouldClose: false };
}

/**
 * Get position summary for a user
 */
export async function getPositionSummary(userId: string) {
  const openPositions = await prisma.position.findMany({
    where: { userId, status: 'OPEN' },
  });
  
  const closedPositions = await prisma.position.findMany({
    where: { userId, status: 'CLOSED' },
    orderBy: { closedAt: 'desc' },
    take: 50,
  });
  
  const totalOpenValue = openPositions.reduce((sum, p) => sum + Number(p.cost), 0);
  const totalPnl = closedPositions.reduce((sum, p) => sum + Number(p.pnl || 0), 0);
  const winCount = closedPositions.filter(p => Number(p.pnl || 0) > 0).length;
  const lossCount = closedPositions.filter(p => Number(p.pnl || 0) < 0).length;
  
  return {
    openPositions,
    closedPositions,
    totalOpenValue,
    totalPnl,
    winRate: closedPositions.length > 0 ? (winCount / closedPositions.length) * 100 : 0,
    winCount,
    lossCount,
  };
}
