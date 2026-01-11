/**
 * Expo Push Notifications Service
 * Sends push notifications to mobile devices via Expo Push API
 */
import prisma from '../config/database.js';

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;
}

interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send a push notification to a user's device
 */
export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<boolean> {
  try {
    // Get user's push token from settings
    const settings = await prisma.userSettings.findUnique({
      where: { userId },
      select: { pushToken: true, notifyOnSignal: true },
    });

    if (!settings?.pushToken) {
      console.log(`[ExpoPush] No push token for user ${userId}`);
      return false;
    }

    // Check if notifications are enabled
    if (settings.notifyOnSignal === false) {
      console.log(`[ExpoPush] Notifications disabled for user ${userId}`);
      return false;
    }

    const message: ExpoPushMessage = {
      to: settings.pushToken,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
      channelId: 'signals',
    };

    console.log(`[ExpoPush] Sending to ${settings.pushToken.substring(0, 30)}...`);

    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(message),
    });

    const result = await response.json() as { data: ExpoPushTicket };
    
    if (result.data?.status === 'ok') {
      console.log(`[ExpoPush] Sent successfully to user ${userId}`);
      return true;
    } else {
      console.error(`[ExpoPush] Failed:`, result.data?.message || result);
      return false;
    }
  } catch (error: any) {
    console.error(`[ExpoPush] Error sending notification:`, error.message);
    return false;
  }
}

/**
 * Send signal notification to user
 */
export async function sendSignalPushNotification(
  userId: string,
  signal: {
    pair: string;
    action: string;
    confidence: number;
    entryPrice?: number;
  }
): Promise<boolean> {
  const title = `🚀 ${signal.action.toUpperCase()} Signal - ${signal.pair.toUpperCase().replace('_', '/')}`;
  const confidencePercent = (signal.confidence * 100).toFixed(0);
  const body = `Confidence: ${confidencePercent}%${signal.entryPrice ? ` | Entry: Rp ${signal.entryPrice.toLocaleString()}` : ''}`;
  
  return sendPushNotification(userId, title, body, {
    type: 'signal',
    pair: signal.pair,
    action: signal.action,
  });
}
