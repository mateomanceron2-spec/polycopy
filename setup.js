#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║      POLYMARKET COPYTRADING BOT - SETUP WIZARD              ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

async function setup() {
  const config = {};

  // Mode selection
  console.log('📊 TRADING MODE');
  const mode = await question('Run in dry-run mode? (y/n) [y]: ');
  config.DRY_RUN_MODE = !mode || mode.toLowerCase() === 'y' ? 'true' : 'false';

  // Wallet configuration
  console.log('\n🔐 WALLET SETUP');
  config.PRIVATE_KEY = await question('Your wallet private key (without 0x): ');
  if (!config.PRIVATE_KEY || config.PRIVATE_KEY.length !== 64) {
    console.log('❌ Invalid private key format. Must be 64 hex characters.');
    process.exit(1);
  }

  config.TARGET_WALLET_ADDRESS = await question('Target wallet to copy (with 0x): ');
  if (!config.TARGET_WALLET_ADDRESS || !config.TARGET_WALLET_ADDRESS.startsWith('0x')) {
    console.log('❌ Invalid wallet address format.');
    process.exit(1);
  }

  // Trading parameters
  console.log('\n💰 TRADING PARAMETERS');
  config.MIN_POSITION_SIZE = await question('Minimum position size in USDC [0.01]: ') || '0.01';
  config.MAX_POSITION_SIZE = await question('Maximum position size in USDC [1000]: ') || '1000';
  config.COPY_RATIO = await question('Copy ratio (1.0 = 100% of target size) [1.0]: ') || '1.0';
  config.MAX_SLIPPAGE = await question('Max slippage tolerance (0.02 = 2%) [0.02]: ') || '0.02';

  // Optional: RPC provider
  console.log('\n🌐 RPC PROVIDER (Optional - press Enter to use default)');
  const rpc = await question('Custom Polygon RPC URL: ');
  if (rpc) {
    config.POLYGON_PUBLIC_RPC_URL = rpc;
  }

  // Write .env file
  const envPath = path.join(__dirname, '.env');
  const envContent = `# Polymarket Copytrade Bot Configuration
# Generated: ${new Date().toISOString()}

# ===========================================
# WALLET CONFIGURATION
# ===========================================
PRIVATE_KEY=${config.PRIVATE_KEY}
TARGET_WALLET_ADDRESS=${config.TARGET_WALLET_ADDRESS}

# ===========================================
# TRADING PARAMETERS
# ===========================================
MIN_POSITION_SIZE=${config.MIN_POSITION_SIZE}
MAX_POSITION_SIZE=${config.MAX_POSITION_SIZE}
COPY_RATIO=${config.COPY_RATIO}
MAX_SLIPPAGE=${config.MAX_SLIPPAGE}

# ===========================================
# DRY RUN MODE
# ===========================================
DRY_RUN_MODE=${config.DRY_RUN_MODE}

# ===========================================
# RPC PROVIDERS
# ===========================================
POLYGON_PUBLIC_RPC_URL=${config.POLYGON_PUBLIC_RPC_URL || 'https://polygon-rpc.com'}

# ===========================================
# POLYMARKET CLOB API
# ===========================================
POLYMARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_REST_URL=https://clob.polymarket.com
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=

# ===========================================
# REDIS (Optional - leave empty to use in-memory cache)
# ===========================================
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# ===========================================
# MONGODB (Optional - leave empty for session-only storage)
# ===========================================
MONGODB_URI=mongodb://localhost:27017
MONGODB_DATABASE=polymarket_copytrade

# ===========================================
# ADVANCED SETTINGS
# ===========================================
GAS_PRICE_MULTIPLIER=1.2
MAX_GAS_PRICE_GWEI=500
RPC_TIMEOUT=5000
LOG_LEVEL=info
NODE_ENV=production
`;

  fs.writeFileSync(envPath, envContent);

  console.log('\n✅ Configuration saved to .env');
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    SETUP COMPLETE!                           ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║                                                              ║');
  console.log('║  Next steps:                                                 ║');
  console.log('║  1. npm install      - Install dependencies                 ║');
  console.log('║  2. npm run build    - Build the bot                        ║');
  console.log('║  3. npm start        - Start trading!                       ║');
  console.log('║                                                              ║');
  if (config.DRY_RUN_MODE === 'true') {
    console.log('║  ⚠️  Running in DRY-RUN mode (no real trades)               ║');
    console.log('║     Set DRY_RUN_MODE=false in .env for live trading        ║');
  } else {
    console.log('║  ⚠️  LIVE MODE - Real trades will be executed!              ║');
    console.log('║     Make sure your wallet has USDC balance                 ║');
  }
  console.log('║                                                              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  rl.close();
}

setup().catch(err => {
  console.error('❌ Setup failed:', err.message);
  process.exit(1);
});
