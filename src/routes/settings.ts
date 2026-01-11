import { Router } from 'express';
import { z } from 'zod';
import prisma from '../config/database.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { TradingMode, RiskProfile } from '@prisma/client';

const router = Router();

// All routes require authentication
router.use(authenticate);

// ============== Schemas ==============

const updateSettingsSchema = z.object({
  tradingMode: z.enum(['MANUAL', 'COPILOT', 'AUTONOMOUS']).optional(),
  riskProfile: z.enum(['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE']).optional(),
  maxPositionPercent: z.number().min(1).max(50).optional(),
  maxOpenPositions: z.number().min(1).max(20).optional(),
  maxDailyTrades: z.number().min(1).max(50).optional(),
  maxDailyLossPercent: z.number().min(1).max(20).optional(),
  alwaysUseStopLoss: z.boolean().optional(),
  stopLossPercent: z.number().min(0.5).max(20).optional(),
  takeProfitPercent: z.number().min(1).max(50).optional(),
  minConfidenceToTrade: z.number().min(0.5).max(0.99).optional(),
  allowedPairs: z.array(z.string()).optional(),
  notifyOnSignal: z.boolean().optional(),
  notifyOnTrade: z.boolean().optional(),
  notifyViaEmail: z.boolean().optional(),
  analysisIntervalMins: z.number().min(5).max(60).optional(),
  // Scalping Mode
  scalpingModeEnabled: z.boolean().optional(),
  scalpingTakeProfitPct: z.number().min(0.5).max(5).optional(),
  scalpingStopLossPct: z.number().min(0.1).max(2).optional(),
  scalpingMaxHoldMins: z.number().min(5).max(60).optional(),
});

const apiKeysSchema = z.object({
  indodaxApiKey: z.string().min(10),
  indodaxSecretKey: z.string().min(10),
});

const geminiKeySchema = z.object({
  geminiApiKey: z.string().min(10),
});

// ============== Routes ==============

/**
 * GET /api/settings
 * Get user settings
 */
router.get('/', async (req: AuthRequest, res) => {
  try {
    const settings = await prisma.userSettings.findUnique({
      where: { userId: req.userId },
    });
    
    if (!settings) {
      // Create default settings if not exists
      const newSettings = await prisma.userSettings.create({
        data: { userId: req.userId! },
      });
      res.json({ settings: newSettings });
      return;
    }
    
    res.json({ settings });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

/**
 * PATCH /api/settings
 * Update user settings
 */
router.patch('/', validateBody(updateSettingsSchema), async (req: AuthRequest, res) => {
  try {
    const settings = await prisma.userSettings.upsert({
      where: { userId: req.userId },
      update: req.body,
      create: {
        userId: req.userId!,
        ...req.body,
      },
    });
    
    res.json({ 
      message: 'Settings updated',
      settings 
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * POST /api/settings/api-keys
 * Save Indodax API keys (encrypted)
 */
router.post('/api-keys', validateBody(apiKeysSchema), async (req: AuthRequest, res) => {
  try {
    const { indodaxApiKey, indodaxSecretKey } = req.body;
    
    // Encrypt the keys before storing
    const encryptedApiKey = encrypt(indodaxApiKey);
    const encryptedSecretKey = encrypt(indodaxSecretKey);
    
    await prisma.user.update({
      where: { id: req.userId },
      data: {
        indodaxApiKey: encryptedApiKey,
        indodaxSecretKey: encryptedSecretKey,
      },
    });
    
    res.json({ message: 'API keys saved successfully' });
  } catch (error) {
    console.error('Save API keys error:', error);
    res.status(500).json({ error: 'Failed to save API keys' });
  }
});

/**
 * DELETE /api/settings/api-keys
 * Remove Indodax API keys
 */
router.delete('/api-keys', async (req: AuthRequest, res) => {
  try {
    await prisma.user.update({
      where: { id: req.userId },
      data: {
        indodaxApiKey: null,
        indodaxSecretKey: null,
      },
    });
    
    res.json({ message: 'API keys removed' });
  } catch (error) {
    console.error('Remove API keys error:', error);
    res.status(500).json({ error: 'Failed to remove API keys' });
  }
});

/**
 * GET /api/settings/api-keys/status
 * Check if API keys are configured
 */
router.get('/api-keys/status', async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        indodaxApiKey: true,
        indodaxSecretKey: true,
        geminiApiKey: true,
      },
    });
    
    res.json({
      indodaxConfigured: !!(user?.indodaxApiKey && user?.indodaxSecretKey),
      geminiConfigured: !!user?.geminiApiKey,
    });
  } catch (error) {
    console.error('Check API keys error:', error);
    res.status(500).json({ error: 'Failed to check API keys' });
  }
});

/**
 * POST /api/settings/gemini-key
 * Save Gemini API key
 */
router.post('/gemini-key', validateBody(geminiKeySchema), async (req: AuthRequest, res) => {
  try {
    const { geminiApiKey } = req.body;
    
    const encryptedKey = encrypt(geminiApiKey);
    
    await prisma.user.update({
      where: { id: req.userId },
      data: { geminiApiKey: encryptedKey },
    });
    
    res.json({ message: 'Gemini API key saved successfully' });
  } catch (error) {
    console.error('Save Gemini key error:', error);
    res.status(500).json({ error: 'Failed to save Gemini API key' });
  }
});

/**
 * DELETE /api/settings/gemini-key
 * Remove Gemini API key
 */
router.delete('/gemini-key', async (req: AuthRequest, res) => {
  try {
    await prisma.user.update({
      where: { id: req.userId },
      data: { geminiApiKey: null },
    });
    
    res.json({ message: 'Gemini API key removed' });
  } catch (error) {
    console.error('Remove Gemini key error:', error);
    res.status(500).json({ error: 'Failed to remove Gemini API key' });
  }
});

/**
 * POST /api/settings/bot/start
 * Start autonomous trading bot
 */
router.post('/bot/start', async (req: AuthRequest, res) => {
  try {
    // Check if API keys are configured
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        indodaxApiKey: true,
        indodaxSecretKey: true,
        settings: true,
      },
    });
    
    if (!user?.indodaxApiKey || !user?.indodaxSecretKey) {
      res.status(400).json({ error: 'Indodax API keys not configured' });
      return;
    }
    
    // Update bot status
    await prisma.userSettings.update({
      where: { userId: req.userId },
      data: { botActive: true },
    });
    
    res.json({ 
      message: 'Trading bot started',
      status: 'active'
    });
  } catch (error) {
    console.error('Start bot error:', error);
    res.status(500).json({ error: 'Failed to start bot' });
  }
});

/**
 * POST /api/settings/bot/stop
 * Stop autonomous trading bot
 */
router.post('/bot/stop', async (req: AuthRequest, res) => {
  try {
    await prisma.userSettings.update({
      where: { userId: req.userId },
      data: { botActive: false },
    });
    
    res.json({ 
      message: 'Trading bot stopped',
      status: 'inactive'
    });
  } catch (error) {
    console.error('Stop bot error:', error);
    res.status(500).json({ error: 'Failed to stop bot' });
  }
});

/**
 * GET /api/settings/bot/status
 * Get bot status
 */
router.get('/bot/status', async (req: AuthRequest, res) => {
  try {
    const settings = await prisma.userSettings.findUnique({
      where: { userId: req.userId },
      select: {
        botActive: true,
        tradingMode: true,
      },
    });
    
    res.json({
      active: settings?.botActive ?? false,
      tradingMode: settings?.tradingMode ?? 'MANUAL',
    });
  } catch (error) {
    console.error('Get bot status error:', error);
    res.status(500).json({ error: 'Failed to get bot status' });
  }
});

/**
 * POST /api/settings/test-notification
 * Send a test notification to verify notification system
 */
router.post('/test-notification', async (req: AuthRequest, res) => {
  try {
    // Import sendNotification dynamically to avoid circular dependency
    const { sendNotification } = await import('../services/websocket.js');
    
    // Create notification in database
    const notification = await prisma.notification.create({
      data: {
        userId: req.userId!,
        type: 'SYSTEM',
        title: '🔔 Test Notification',
        message: 'Ini adalah test notifikasi. Jika Anda melihat ini, sistem notifikasi berjalan dengan baik!',
        data: { test: true, timestamp: new Date().toISOString() },
      },
    });
    
    // Send via WebSocket
    sendNotification(req.userId!, {
      id: notification.id,
      type: 'SYSTEM',
      title: notification.title,
      message: notification.message,
      createdAt: notification.createdAt.toISOString(),
    });
    
    res.json({ 
      message: 'Test notification sent',
      notification: {
        id: notification.id,
        title: notification.title,
        message: notification.message,
      },
    });
  } catch (error) {
    console.error('Test notification error:', error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

export default router;
