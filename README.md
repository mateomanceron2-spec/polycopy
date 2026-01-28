# Polymarket Copy Trade Bot

A high-performance, event-driven copytrading bot for Polymarket built with TypeScript.

## 🚀 Performance Targets

- **End-to-end latency**: 1.5-3 seconds from trade detection to execution
- **WebSocket monitoring**: ~100ms update latency
- **Architecture**: Pure event-driven (no polling)

## 📁 Project Structure

```
/src
  /config      - Configuration and environment variables
  /services    - Core services (WebSocket, RPC, trading)
  /utils       - Helper functions (nonce management, gas optimization)
  /monitors    - Trade detection logic
  /executors   - Order placement engine
```

## 🛠 Technology Stack

- **Language**: Node.js with TypeScript
- **RPC Provider**: Infura Polygon (primary) + QuickNode (failover)
- **Real-time Data**: WebSocket connections to Polymarket CLOB API
- **Database**: Redis (in-memory caching) + MongoDB (persistence)
- **Network**: Designed for low-latency VPS deployment

## ⚡ Key Features

- **Real-time trade detection** via WebSocket subscriptions
- **Automatic failover** between RPC providers
- **Optimized gas management** for fast execution
- **Nonce management** to prevent transaction conflicts
- **Health monitoring** with automatic recovery
- **Comprehensive logging** with performance metrics

## 📋 Prerequisites

- Node.js 18+ 
- Redis server (optional, falls back to in-memory)
- MongoDB server
- Polygon wallet with MATIC (for gas) and USDC
- Polymarket API credentials

## 🔧 Installation

1. **Clone and install dependencies**:
```bash
cd polycopytrade
npm install
```

2. **Configure environment**:
```bash
cp .env.example .env
# Edit .env with your credentials
```

3. **Build the project**:
```bash
npm run build
```

4. **Run the bot**:
```bash
npm start
```

## ⚙️ Configuration

Copy `.env.example` to `.env` and configure:

### Required Settings

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Your wallet private key |
| `TARGET_WALLET_ADDRESS` | Address to copytrade |
| `INFURA_PROJECT_ID` | Infura project ID |
| `POLYMARKET_API_KEY` | Polymarket CLOB API key |
| `POLYMARKET_API_SECRET` | Polymarket API secret |
| `POLYMARKET_API_PASSPHRASE` | Polymarket passphrase |

### Trading Parameters

| Variable | Default | Description |
|----------|---------|-------------|
| `COPY_RATIO` | 1.0 | Copy ratio (1.0 = 100%) |
| `MAX_POSITION_SIZE` | 1000 | Max position in USDC |
| `MIN_POSITION_SIZE` | 10 | Min position in USDC |
| `MAX_SLIPPAGE` | 0.02 | Max slippage (2%) |
| `GAS_PRICE_MULTIPLIER` | 1.2 | Gas price multiplier |

## 🏗 Architecture

### Event Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Polymarket    │────▶│   Trade         │────▶│   Order         │
│   WebSocket     │     │   Monitor       │     │   Executor      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │                       ▼                       ▼
        │               ┌─────────────────┐     ┌─────────────────┐
        │               │   Signal        │     │   Polymarket    │
        │               │   Generation    │     │   CLOB API      │
        │               └─────────────────┘     └─────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Redis         │     │   MongoDB       │     │   Polygon       │
│   (Hot Cache)   │     │   (Persistence) │     │   (Settlement)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Components

1. **WebSocket Service** (`services/websocket.ts`)
   - Maintains persistent connection to Polymarket
   - Auto-reconnection with exponential backoff
   - Subscribes to live activity and user feeds

2. **RPC Service** (`services/rpc.ts`)
   - Multi-provider setup with automatic failover
   - Health monitoring and latency tracking
   - Retry logic with exponential backoff

3. **Trade Monitor** (`monitors/tradeMonitor.ts`)
   - Filters trades from target wallet
   - Generates copy signals with calculated sizes
   - Tracks detection latency metrics

4. **Order Executor** (`executors/orderExecutor.ts`)
   - EIP-712 order signing
   - Nonce management for parallel orders
   - Gas optimization for fast execution

5. **Cache Service** (`services/cache.ts`)
   - Redis for hot-path data (nonces, gas prices)
   - Automatic fallback to local cache
   - TTL-based expiration

6. **Database Service** (`services/database.ts`)
   - MongoDB for trade history and metrics
   - Error logging for debugging
   - Performance analytics

## 📊 Performance Optimization

### Latency Reduction Strategies

1. **WebSocket over REST**: Real-time data without polling overhead
2. **Pre-fetched gas prices**: Cached and updated every 5 seconds
3. **Nonce pre-allocation**: Prevents serial transaction submission
4. **Connection pooling**: Reused RPC and DB connections
5. **Event-driven architecture**: No busy-waiting or delays

### Deployment Recommendations

- Deploy on low-latency VPS close to Polygon validators
- Use dedicated Redis instance for sub-millisecond cache access
- Configure aggressive gas prices during high-activity periods
- Monitor with provided health endpoints

## 🔒 Security

- Private keys are loaded from environment variables only
- API credentials use HMAC-SHA256 signing
- No credentials are logged or persisted
- Use hardware wallets for production

## 📈 Monitoring

The bot provides real-time metrics:

```typescript
// Trade Monitor Metrics
{
  avgDetectionLatency: 85,    // ms
  totalTradesProcessed: 1250,
  signalsGenerated: 47
}

// Order Executor Metrics
{
  avgExecutionLatency: 1200,  // ms
  successRate: 98.5,          // %
  pendingCount: 0
}
```

## 🐛 Troubleshooting

### Common Issues

1. **WebSocket disconnections**
   - Check network stability
   - Verify API credentials
   - Review rate limits

2. **High latency**
   - Check RPC provider health
   - Verify Redis connection
   - Review gas price settings

3. **Failed orders**
   - Check USDC balance
   - Verify USDC approval
   - Review slippage settings

### Debug Mode

Set `LOG_LEVEL=debug` in `.env` for verbose logging.

## 📄 License

MIT

## ⚠️ Disclaimer

This bot is for educational purposes. Trading carries significant risk. Always test with small amounts first. Not financial advice.
