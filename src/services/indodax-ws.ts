import WebSocket from 'ws';
import { config } from '../config/index.js';
import { broadcastTicker, broadcastMarketSummary, TickerUpdate, MarketSummary } from './websocket.js';

let ws: WebSocket | null = null;
let isConnected = false;
let reconnectTimeout: NodeJS.Timeout | null = null;
let subscribedChannels: Set<string> = new Set();
let messageIdCounter = 10;

const RECONNECT_DELAY = 3000; // 3 seconds like mobile

// Parse market summary data from Indodax WebSocket
function parseMarketSummary(data: any[][]): MarketSummary[] {
  return data.map(item => ({
    pair: item[0] as string,
    last: Number(item[2]),
    change24h: ((Number(item[2]) - Number(item[5])) / Number(item[5])) * 100,
    volume24h: Number(item[6]),
  }));
}

// Parse ticker update
function parseTickerUpdate(item: any[]): TickerUpdate {
  return {
    pair: item[0] as string,
    last: Number(item[2]),
    high24h: Number(item[4] || 0),
    low24h: Number(item[3] || 0),
    volume24h: Number(item[6] || 0),
    change24h: ((Number(item[2]) - Number(item[5])) / Number(item[5])) * 100,
    timestamp: Number(item[1] || Date.now()),
  };
}

/**
 * Send subscribe message for a channel
 */
function sendSubscribe(channel: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  
  const payload = {
    method: 1, // Subscribe
    params: { channel },
    id: messageIdCounter++,
  };
  ws.send(JSON.stringify(payload));
  console.log(`[IndodaxWS] Subscribing to ${channel}`);
}

/**
 * Connect to Indodax Market WebSocket
 * Implementation matches mobile React project
 */
export function connectToIndodaxWS(): void {
  if (ws?.readyState === WebSocket.OPEN) {
    console.log('[IndodaxWS] Already connected');
    return;
  }
  
  // Clear any pending reconnect
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  console.log('[IndodaxWS] Connecting to Indodax WebSocket...');
  
  ws = new WebSocket(config.indodax.wsMarketUrl);
  
  ws.on('open', () => {
    console.log('[IndodaxWS] Connected');
    isConnected = true;
    
    // Authenticate with static token (same as mobile)
    const authPayload = {
      params: { token: config.indodax.wsStaticToken },
      id: 1, // ID for Auth
    };
    ws?.send(JSON.stringify(authPayload));
  });
  
  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(message);
    } catch (error) {
      console.error('[IndodaxWS] Error parsing message:', error);
    }
  });
  
  ws.on('error', (error) => {
    console.error('[IndodaxWS] WebSocket error:', error.message);
    ws?.close();
  });
  
  ws.on('close', (code) => {
    console.log(`[IndodaxWS] Disconnected (code: ${code}). Reconnecting in ${RECONNECT_DELAY/1000}s...`);
    isConnected = false;
    ws = null;
    
    // Auto reconnect like mobile (using setTimeout, not setInterval)
    reconnectTimeout = setTimeout(() => {
      connectToIndodaxWS();
    }, RECONNECT_DELAY);
  });
  
  // Subscribe to market summary by default
  subscribedChannels.add('market:summary-24h');
}

/**
 * Handle incoming WebSocket message
 */
function handleMessage(message: any): void {
  // Check if auth successful (ID 1)
  if (message.id === 1 && message.result?.client) {
    console.log('[IndodaxWS] Authenticated successfully');
    
    // Subscribe to all channels
    subscribedChannels.forEach(channel => sendSubscribe(channel));
    return;
  }
  
  // Handle subscription confirmation
  if (message.id && message.id > 1 && message.result?.channel) {
    console.log(`[IndodaxWS] Subscribed to ${message.result.channel}`);
    return;
  }
  
  // Handle Channel Update (push messages)
  // Format: { result: { channel: "market:summary-24h", data: { data: [...] } } }
  if (message.result?.channel) {
    const channel = message.result.channel;
    const payload = message.result.data;
    
    if (channel === 'market:summary-24h' && payload?.data) {
      const summaryData = payload.data;
      
      if (Array.isArray(summaryData) && summaryData.length > 0) {
        const summaries = parseMarketSummary(summaryData);
        
        // Broadcast to connected dashboard clients
        broadcastMarketSummary(summaries);
        
        // Log occasionally (not every update to avoid spam)
        if (Math.random() < 0.01) {
          console.log(`[IndodaxWS] Broadcasting ${summaries.length} market updates`);
        }
      }
    }
  }
}

/**
 * Disconnect from Indodax WebSocket
 */
export function disconnectFromIndodaxWS(): void {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
    isConnected = false;
    console.log('[IndodaxWS] Disconnected');
  }
}

/**
 * Check if connected to Indodax WebSocket
 */
export function isIndodaxWSConnected(): boolean {
  return isConnected && ws !== null && ws.readyState === WebSocket.OPEN;
}
