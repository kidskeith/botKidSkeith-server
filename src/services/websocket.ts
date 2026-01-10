import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import prisma from '../config/database.js';
import { JWTPayload } from '../middleware/auth.js';

// Extend Socket with user info
interface AuthenticatedSocket extends Socket {
  userId?: string;
  userEmail?: string;
}

// WebSocket event types
export interface WSEvents {
  // Server -> Client
  'market:ticker': (data: TickerUpdate) => void;
  'market:summary': (data: MarketSummary[]) => void;
  'signal:new': (data: SignalNotification) => void;
  'signal:update': (data: SignalNotification) => void;
  'trade:update': (data: TradeNotification) => void;
  'notification': (data: NotificationData) => void;
  'error': (data: { message: string }) => void;
  
  // Client -> Server
  'subscribe:pair': (pair: string) => void;
  'unsubscribe:pair': (pair: string) => void;
  'subscribe:signals': () => void;
  'subscribe:trades': () => void;
}

export interface TickerUpdate {
  pair: string;
  last: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  change24h: number;
  timestamp: number;
}

export interface MarketSummary {
  pair: string;
  last: number;
  change24h: number;
  volume24h: number;
}

export interface SignalNotification {
  id: string;
  pair: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  status: string;
  reasoning: string;
  createdAt: string;
}

export interface TradeNotification {
  id: string;
  pair: string;
  type: 'BUY' | 'SELL';
  status: string;
  price: number;
  amount: number;
  pnl?: number;
  updatedAt: string;
}

export interface NotificationData {
  id: string;
  type: string;
  title: string;
  message: string;
  createdAt: string;
}

// Store connected users and their subscriptions
const userSockets = new Map<string, Set<string>>(); // userId -> Set<socketId>
const pairSubscriptions = new Map<string, Set<string>>(); // pair -> Set<socketId>

let io: Server;

/**
 * Initialize WebSocket server
 */
export function initializeWebSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigins,
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });
  
  // Authentication middleware
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        // Allow anonymous connections for public market data
        return next();
      }
      
      // Verify JWT
      const payload = jwt.verify(token, config.jwtSecret) as JWTPayload;
      
      // Check session
      const session = await prisma.session.findFirst({
        where: {
          userId: payload.userId,
          expiresAt: { gt: new Date() },
        },
      });
      
      if (!session) {
        return next(new Error('Session expired'));
      }
      
      socket.userId = payload.userId;
      socket.userEmail = payload.email;
      next();
    } catch (error) {
      next(new Error('Authentication failed'));
    }
  });
  
  // Connection handler
  io.on('connection', (socket: AuthenticatedSocket) => {
    console.log(`[WS] Client connected: ${socket.id} ${socket.userId ? `(user: ${socket.userId})` : '(anonymous)'}`);
    
    // Track authenticated users
    if (socket.userId) {
      if (!userSockets.has(socket.userId)) {
        userSockets.set(socket.userId, new Set());
      }
      userSockets.get(socket.userId)!.add(socket.id);
    }
    
    // Subscribe to a trading pair for ticker updates
    socket.on('subscribe:pair', (pair: string) => {
      const normalizedPair = pair.toLowerCase().replace('/', '_').replace('-', '_');
      socket.join(`pair:${normalizedPair}`);
      
      if (!pairSubscriptions.has(normalizedPair)) {
        pairSubscriptions.set(normalizedPair, new Set());
      }
      pairSubscriptions.get(normalizedPair)!.add(socket.id);
      
      console.log(`[WS] ${socket.id} subscribed to pair: ${normalizedPair}`);
    });
    
    // Unsubscribe from a pair
    socket.on('unsubscribe:pair', (pair: string) => {
      const normalizedPair = pair.toLowerCase().replace('/', '_').replace('-', '_');
      socket.leave(`pair:${normalizedPair}`);
      pairSubscriptions.get(normalizedPair)?.delete(socket.id);
      console.log(`[WS] ${socket.id} unsubscribed from pair: ${normalizedPair}`);
    });
    
    // Subscribe to signals (authenticated only)
    socket.on('subscribe:signals', () => {
      if (!socket.userId) {
        socket.emit('error', { message: 'Authentication required' });
        return;
      }
      socket.join(`signals:${socket.userId}`);
      console.log(`[WS] ${socket.id} subscribed to signals`);
    });
    
    // Subscribe to trades (authenticated only)
    socket.on('subscribe:trades', () => {
      if (!socket.userId) {
        socket.emit('error', { message: 'Authentication required' });
        return;
      }
      socket.join(`trades:${socket.userId}`);
      console.log(`[WS] ${socket.id} subscribed to trades`);
    });
    
    // Disconnect handler
    socket.on('disconnect', () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
      
      // Clean up user sockets
      if (socket.userId) {
        userSockets.get(socket.userId)?.delete(socket.id);
        if (userSockets.get(socket.userId)?.size === 0) {
          userSockets.delete(socket.userId);
        }
      }
      
      // Clean up pair subscriptions
      pairSubscriptions.forEach((sockets, pair) => {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          pairSubscriptions.delete(pair);
        }
      });
    });
  });
  
  console.log('[WS] WebSocket server initialized');
  return io;
}

/**
 * Get the Socket.io server instance
 */
export function getIO(): Server {
  if (!io) {
    throw new Error('WebSocket server not initialized');
  }
  return io;
}

/**
 * Broadcast ticker update to subscribed clients
 */
export function broadcastTicker(update: TickerUpdate): void {
  if (!io) return;
  io.to(`pair:${update.pair}`).emit('market:ticker', update);
}

/**
 * Broadcast market summary to all clients
 */
export function broadcastMarketSummary(summaries: MarketSummary[]): void {
  if (!io) return;
  io.emit('market:summary', summaries);
}

/**
 * Send signal notification to a specific user
 */
export function sendSignalNotification(userId: string, signal: SignalNotification): void {
  if (!io) return;
  io.to(`signals:${userId}`).emit('signal:new', signal);
}

/**
 * Send trade update to a specific user
 */
export function sendTradeUpdate(userId: string, trade: TradeNotification): void {
  if (!io) return;
  io.to(`trades:${userId}`).emit('trade:update', trade);
}

/**
 * Send notification to a specific user
 */
export function sendNotification(userId: string, notification: NotificationData): void {
  if (!io) return;
  
  const userSocketIds = userSockets.get(userId);
  if (userSocketIds) {
    userSocketIds.forEach(socketId => {
      io.to(socketId).emit('notification', notification);
    });
  }
}

/**
 * Check if a user is connected
 */
export function isUserConnected(userId: string): boolean {
  return userSockets.has(userId) && userSockets.get(userId)!.size > 0;
}

/**
 * Get connected user count
 */
export function getConnectedUserCount(): number {
  return userSockets.size;
}

/**
 * Get total connection count
 */
export function getTotalConnectionCount(): number {
  if (!io) return 0;
  return io.engine.clientsCount;
}
