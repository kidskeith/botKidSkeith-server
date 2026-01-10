import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config, validateConfig } from './config/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import routes from './routes/index.js';
import { initializeWebSocket, getConnectedUserCount, getTotalConnectionCount } from './services/websocket.js';
import { connectToIndodaxWS, isIndodaxWSConnected } from './services/indodax-ws.js';
import { startScheduledJobs } from './jobs/index.js';

// Validate config
validateConfig();

// Create Express app
const app = express();

// Create HTTP server
const httpServer = createServer(app);

// Initialize WebSocket
const io = initializeWebSocket(httpServer);

// ============== Middleware ==============

// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: config.corsOrigins,
  credentials: true,
}));

// Request logging
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============== Routes ==============

// API routes
app.use('/api', routes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'AI Trading Bot API',
    version: '1.1.0',
    status: 'running',
    docs: '/api/health',
    websocket: {
      connected: getTotalConnectionCount(),
      users: getConnectedUserCount(),
      indodaxStream: isIndodaxWSConnected(),
    },
  });
});

// ============== Error Handling ==============

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// ============== Start Server ==============

const PORT = config.port;

httpServer.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                 AI Trading Bot Backend                     ║
╠═══════════════════════════════════════════════════════════╣
║  Status:     Running                                       ║
║  Port:       ${PORT}                                          ║
║  Mode:       ${config.nodeEnv.padEnd(11)}                              ║
║  API:        http://localhost:${PORT}/api                     ║
║  WebSocket:  ws://localhost:${PORT}                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
  
  // Connect to Indodax WebSocket for market data
  if (config.nodeEnv !== 'test') {
    setTimeout(() => {
      connectToIndodaxWS();
    }, 2000);
    
    // Start scheduled background jobs (AI analysis, position monitor)
    setTimeout(async () => {
      try {
        await startScheduledJobs();
        console.log('[Server] Background jobs initialized');
      } catch (error) {
        console.error('[Server] Failed to start scheduled jobs:', error);
      }
    }, 3000);
  }
});

export { app, httpServer, io };
