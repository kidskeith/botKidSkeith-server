import { Router } from 'express';
import authRoutes from './auth.js';
import marketRoutes from './market.js';
import settingsRoutes from './settings.js';
import tradingRoutes from './trading.js';
import signalsRoutes from './signals.js';
import jobsRoutes from './jobs.js';

const router = Router();

// Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Mount routes
router.use('/auth', authRoutes);
router.use('/market', marketRoutes);
router.use('/settings', settingsRoutes);
router.use('/trades', tradingRoutes);
router.use('/account', tradingRoutes);
router.use('/signals', signalsRoutes);
router.use('/jobs', jobsRoutes);

export default router;
