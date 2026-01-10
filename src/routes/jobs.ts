import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { analysisQueue, orderMonitorQueue, notificationQueue, schedulePeriodicAnalysis } from '../jobs/index.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/jobs/status
 * Get job queue status
 */
router.get('/status', async (req: AuthRequest, res) => {
  try {
    const [analysisCount, orderCount, notificationCount] = await Promise.all([
      analysisQueue.getJobCounts(),
      orderMonitorQueue.getJobCounts(),
      notificationQueue.getJobCounts(),
    ]);
    
    res.json({
      queues: {
        analysis: analysisCount,
        orderMonitor: orderCount,
        notifications: notificationCount,
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
    const pairs = pair ? [pair] : ['btc_idr', 'eth_idr'];
    
    const jobs = [];
    for (const p of pairs) {
      const job = await analysisQueue.add(
        'manual-analysis',
        {
          userId: req.userId!,
          pair: p,
          reason: 'manual',
        }
      );
      jobs.push({ jobId: job.id, pair: p });
    }
    
    res.json({
      message: 'Analysis jobs queued',
      jobs,
    });
  } catch (error) {
    console.error('Queue analysis error:', error);
    res.status(500).json({ error: 'Failed to queue analysis' });
  }
});

/**
 * POST /api/jobs/scheduler/start
 * Start the periodic scheduler (admin only)
 */
router.post('/scheduler/start', async (req: AuthRequest, res) => {
  try {
    await schedulePeriodicAnalysis();
    res.json({ message: 'Scheduler triggered' });
  } catch (error) {
    console.error('Start scheduler error:', error);
    res.status(500).json({ error: 'Failed to start scheduler' });
  }
});

/**
 * GET /api/jobs/history
 * Get job history for current user
 */
router.get('/history', async (req: AuthRequest, res) => {
  try {
    const { limit = 20 } = req.query;
    
    const completed = await analysisQueue.getCompleted(0, Number(limit));
    const failed = await analysisQueue.getFailed(0, Number(limit));
    
    // Filter by user
    const userCompleted = completed.filter(job => job.data.userId === req.userId);
    const userFailed = failed.filter(job => job.data.userId === req.userId);
    
    res.json({
      completed: userCompleted.map(job => ({
        id: job.id,
        pair: job.data.pair,
        reason: job.data.reason,
        result: job.returnvalue,
        completedAt: job.finishedOn,
      })),
      failed: userFailed.map(job => ({
        id: job.id,
        pair: job.data.pair,
        reason: job.data.reason,
        error: job.failedReason,
        failedAt: job.finishedOn,
      })),
    });
  } catch (error) {
    console.error('Get job history error:', error);
    res.status(500).json({ error: 'Failed to get job history' });
  }
});

export default router;
