# AI Trading Bot - Backend

Backend server untuk AI-powered cryptocurrency trading bot yang terintegrasi dengan Indodax.

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: PostgreSQL (via Prisma)
- **Cache/Queue**: Redis + BullMQ
- **Real-time**: Socket.io

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Environment

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your credentials
```

Required environment variables:

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `JWT_SECRET` - Secret for JWT tokens (min 32 chars)
- `ENCRYPTION_KEY` - Key for encrypting API keys (32 bytes hex)

Generate encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Setup Database

```bash
# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push

# Or create migration
npm run db:migrate
```

### 4. Run Development Server

```bash
npm run dev
```

Server will start at `http://localhost:3001`

## Scripts

| Command               | Description                              |
| --------------------- | ---------------------------------------- |
| `npm run dev`         | Start development server with hot reload |
| `npm run build`       | Build for production                     |
| `npm start`           | Run production build                     |
| `npm run db:generate` | Generate Prisma client                   |
| `npm run db:push`     | Push schema to database                  |
| `npm run db:migrate`  | Run database migrations                  |
| `npm run db:studio`   | Open Prisma Studio                       |

## Project Structure

```
backend/
├── prisma/
│   └── schema.prisma     # Database schema
├── src/
│   ├── config/           # Configuration
│   ├── controllers/      # Route handlers
│   ├── middleware/       # Express middleware
│   ├── routes/           # API routes
│   ├── services/         # Business logic
│   ├── utils/            # Utilities
│   ├── jobs/             # Background jobs
│   └── index.ts          # Entry point
├── .env.example          # Environment template
├── package.json
└── tsconfig.json
```

## API Endpoints

### Authentication

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Market Data

- `GET /api/market/pairs` - Get trading pairs
- `GET /api/market/summaries` - Get market summaries
- `GET /api/market/ticker/:pair` - Get ticker
- `GET /api/market/depth/:pair` - Get order book
- `GET /api/market/ohlc/:pair` - Get candlestick data

### Health

- `GET /api/health` - Health check

## Database Schema

See `prisma/schema.prisma` for full schema. Main models:

- **User** - User accounts with encrypted API keys
- **UserSettings** - Trading configuration
- **Trade** - Trade history
- **Signal** - AI trading signals
- **Notification** - User notifications
- **MarketData** - Cached market data

## Security Notes

1. **API Keys** - Stored encrypted using AES-256-GCM
2. **Passwords** - Hashed with bcrypt (12 rounds)
3. **JWT** - Tokens expire after 7 days
4. **Sessions** - Stored in database, can be revoked

## Recommended Managed Services

### Database (PostgreSQL)

- [Supabase](https://supabase.com) - Free tier available
- [Neon](https://neon.tech) - Serverless PostgreSQL
- [Railway](https://railway.app) - Simple deployment

### Redis

- [Upstash](https://upstash.com) - Serverless Redis
- [Railway](https://railway.app) - Redis add-on

## License

ISC
