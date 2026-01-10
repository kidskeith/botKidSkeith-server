import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  // Server
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),
  apiUrl: process.env.API_URL || 'http://localhost:3001',
  
  // Database
  databaseUrl: process.env.DATABASE_URL || '',
  
  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  redis: (() => {
    const url = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
    const isTls = url.protocol === 'rediss:';
    return {
      host: url.hostname,
      port: parseInt(url.port || '6379', 10),
      password: url.password || undefined,
      tls: isTls ? {} : undefined,
    };
  })(),
  
  // JWT
  jwtSecret: process.env.JWT_SECRET || 'development-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  
  // Encryption
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  
  // Indodax
  indodax: {
    apiKey: process.env.INDODAX_API_KEY || '',
    secretKey: process.env.INDODAX_SECRET_KEY || '',
    publicApiUrl: 'https://indodax.com/api',
    privateApiUrl: 'https://indodax.com/tapi',
    wsMarketUrl: 'wss://ws3.indodax.com/ws/',
    wsPrivateUrl: 'wss://pws.indodax.com/ws/',
    wsStaticToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE5NDY2MTg0MTV9.UR1lBM6Eqh0yWz-PVirw1uPCxe60FdchR8eNVdsskeo',
  },
  
  // Gemini AI
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  
  // CORS
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:8081').split(','),
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'debug',
  
  // Push Notifications
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN || '',
  
  // Email
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
} as const;

// Validate required config in production
export function validateConfig(): void {
  const required = ['DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY'];
  
  if (config.nodeEnv === 'production') {
    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(`Missing required environment variable: ${key}`);
      }
    }
  }
}
