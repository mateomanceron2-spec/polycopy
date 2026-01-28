import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface Config {
  // RPC Providers (Multi-provider with failover)
  rpc: {
    // Primary: Infura
    infura: {
      projectId: string;
      url: string;
      wsUrl: string;
    };
    // Secondary: Polygon Public RPC (free, no WebSocket)
    polygonPublic: {
      url: string;
    };
    // Tertiary: Alchemy (optional)
    alchemy: {
      apiKey: string;
      url: string;
      wsUrl: string;
    };
    // Legacy: QuickNode (kept for compatibility)
    quicknode: {
      url: string;
      wsUrl: string;
    };
    // Timeouts and retry settings
    timeout: number;
    maxRetries: number;
  };

  // Polymarket API
  polymarket: {
    wsUrl: string;
    restUrl: string;
    apiKey: string;
    apiSecret: string;
    passphrase: string;
  };

  // Wallet Configuration
  wallet: {
    privateKey: string;
    targetAddresses: string[];  // Support multiple targets
    signatureType: number;      // 0=EOA, 1=Proxy(email), 2=Proxy(browser)
    minBalance: number;         // Minimum USDC balance to trade
  };

  // Redis
  redis: {
    host: string;
    port: number;
    password: string;
    db: number;
  };

  // MongoDB
  mongodb: {
    uri: string;
    database: string;
  };

  // Trading Parameters (STEP 4)
  trading: {
    // Position Sizing
    tradeMultiplier: number;        // Copy ratio (default 1.0)
    minTradeSize: number;           // Minimum trade in USDC (default $5)
    maxPositionPercent: number;     // Max % of balance per trade (default 20%)
    minGasReserve: number;          // Min MATIC to keep (default 2)
    
    // Slippage & Pricing
    maxSlippagePercent: number;     // Max slippage % (default 3%)
    pricePremiumCents: number;      // Price premium in cents (default 1)
    
    // Order Settings
    defaultOrderType: 'FOK' | 'GTC' | 'GTD';  // Fill-or-Kill recommended
    orderExpirationSeconds: number;  // Order expiration (default 60)
    
    // Safety Limits
    dailyLossLimit: number;         // Max daily loss in USDC (default $100)
    maxConsecutiveFailures: number; // Circuit breaker threshold (default 3)
    circuitBreakerPauseMinutes: number; // Pause duration (default 5)
    
    // Cooldowns
    marketCooldownSeconds: number;  // Cooldown per market (default 60)
    
    // Modes
    dryRunMode: boolean;            // Log trades without executing
    
    // Whitelists/Blacklists
    marketWhitelist: string[];      // Only trade these markets (empty = all)
    marketBlacklist: string[];      // Skip these markets
    categoryBlacklist: string[];    // Skip these categories
    
    // Legacy (kept for compatibility)
    maxPositionSize: number;
    minPositionSize: number;
    copyRatio: number;
    maxSlippage: number;
    gasPriceMultiplier: number;
    maxGasPriceGwei: number;
  };

  // Performance & Failover
  performance: {
    wsReconnectDelay: number;
    wsMaxReconnectAttempts: number;
    wsReconnectMaxDelay: number;
    wsHeartbeatInterval: number;
    httpPollingInterval: number;
    httpPollingFallbackAfterAttempts: number;
    wsBackgroundReconnectInterval: number;
    rpcTimeout: number;
    nonceCacheTtl: number;
  };

  // Health Monitoring
  health: {
    checkInterval: number;
    noEventWarningThreshold: number;
    noEventCriticalThreshold: number;
    dailyUptimeThreshold: number;
  };

  // Alerts (Telegram/Discord)
  alerts: {
    enabled: boolean;
    webhookUrl: string;           // Discord/Slack webhook
    telegramBotToken: string;     // Telegram bot token
    telegramChatId: string;       // Telegram chat ID
    discordWebhookUrl: string;    // Discord webhook URL
    emailTo: string;
  };

  // Control Features
  control: {
    killSwitchKey: string;        // Redis key for kill switch
    pauseKey: string;             // Redis key for pause
    configWatchEnabled: boolean;  // Watch config file for changes
    killSwitchCheckInterval: number; // Check interval in ms (default 5000)
    dryRunMode: boolean;          // Dry-run mode (no real trades)
    enableConfigWatch: boolean;   // Hot-reload config on file change
  };

  // Logging
  logLevel: string;
  nodeEnv: string;
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvVarAsNumber(key: string, defaultValue?: number): number {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number`);
  }
  return parsed;
}

function getEnvVarAsArray(key: string, defaultValue: string[] = []): string[] {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

export const config: Config = {
  rpc: {
    // Primary: Infura (WebSocket + HTTP)
    infura: {
      projectId: getEnvVar('INFURA_PROJECT_ID', ''),
      url: getEnvVar('INFURA_RPC_URL', 'https://polygon-mainnet.infura.io/v3/'),
      wsUrl: getEnvVar('INFURA_WS_URL', 'wss://polygon-mainnet.infura.io/ws/v3/'),
    },
    // Secondary: Polygon Public RPC (HTTP only, free)
    polygonPublic: {
      url: getEnvVar('POLYGON_PUBLIC_RPC_URL', 'https://polygon-rpc.com'),
    },
    // Tertiary: Alchemy (optional)
    alchemy: {
      apiKey: getEnvVar('ALCHEMY_API_KEY', ''),
      url: getEnvVar('ALCHEMY_RPC_URL', 'https://polygon-mainnet.g.alchemy.com/v2/'),
      wsUrl: getEnvVar('ALCHEMY_WS_URL', 'wss://polygon-mainnet.g.alchemy.com/v2/'),
    },
    // Legacy: QuickNode
    quicknode: {
      url: getEnvVar('QUICKNODE_RPC_URL', ''),
      wsUrl: getEnvVar('QUICKNODE_WS_URL', ''),
    },
    timeout: getEnvVarAsNumber('RPC_TIMEOUT', 5000),
    maxRetries: getEnvVarAsNumber('RPC_MAX_RETRIES', 3),
  },

  polymarket: {
    wsUrl: getEnvVar('POLYMARKET_WS_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/market'),
    restUrl: getEnvVar('POLYMARKET_REST_URL', 'https://clob.polymarket.com'),
    apiKey: getEnvVar('POLYMARKET_API_KEY', ''),
    apiSecret: getEnvVar('POLYMARKET_API_SECRET', ''),
    passphrase: getEnvVar('POLYMARKET_API_PASSPHRASE', ''),
  },

  wallet: {
    privateKey: getEnvVar('PRIVATE_KEY', ''),
    targetAddresses: getEnvVarAsArray('TARGET_WALLETS', [getEnvVar('TARGET_WALLET_ADDRESS', '')]),
    signatureType: getEnvVarAsNumber('SIGNATURE_TYPE', 0), // 0=EOA, 1=Proxy(email), 2=Proxy(browser)
    minBalance: getEnvVarAsNumber('MIN_BALANCE', 100),     // Minimum USDC to maintain
  },

  redis: {
    host: getEnvVar('REDIS_HOST', '127.0.0.1'),
    port: getEnvVarAsNumber('REDIS_PORT', 6379),
    password: getEnvVar('REDIS_PASSWORD', ''),
    db: getEnvVarAsNumber('REDIS_DB', 0),
  },

  mongodb: {
    uri: getEnvVar('MONGODB_URI', 'mongodb://localhost:27017'),
    database: getEnvVar('MONGODB_DATABASE', 'polymarket_copytrade'),
  },

  trading: {
    // Position Sizing
    tradeMultiplier: getEnvVarAsNumber('TRADE_MULTIPLIER', 1.0),
    minTradeSize: getEnvVarAsNumber('MIN_TRADE_SIZE', 5),
    maxPositionPercent: getEnvVarAsNumber('MAX_POSITION_PERCENT', 20),
    minGasReserve: getEnvVarAsNumber('MIN_GAS_RESERVE', 2),
    
    // Slippage & Pricing
    maxSlippagePercent: getEnvVarAsNumber('MAX_SLIPPAGE_PERCENT', 3),
    pricePremiumCents: getEnvVarAsNumber('PRICE_PREMIUM_CENTS', 1),
    
    // Order Settings
    defaultOrderType: getEnvVar('DEFAULT_ORDER_TYPE', 'FOK') as 'FOK' | 'GTC' | 'GTD',
    orderExpirationSeconds: getEnvVarAsNumber('ORDER_EXPIRATION_SECONDS', 60),
    
    // Safety Limits
    dailyLossLimit: getEnvVarAsNumber('DAILY_LOSS_LIMIT', 100),
    maxConsecutiveFailures: getEnvVarAsNumber('MAX_CONSECUTIVE_FAILURES', 3),
    circuitBreakerPauseMinutes: getEnvVarAsNumber('CIRCUIT_BREAKER_PAUSE_MINUTES', 5),
    
    // Cooldowns
    marketCooldownSeconds: getEnvVarAsNumber('MARKET_COOLDOWN_SECONDS', 60),
    
    // Modes
    dryRunMode: getEnvVar('DRY_RUN_MODE', 'false') === 'true',
    
    // Whitelists/Blacklists
    marketWhitelist: getEnvVarAsArray('MARKET_WHITELIST'),
    marketBlacklist: getEnvVarAsArray('MARKET_BLACKLIST'),
    categoryBlacklist: getEnvVarAsArray('CATEGORY_BLACKLIST'),
    
    // Legacy (kept for compatibility)
    maxPositionSize: getEnvVarAsNumber('MAX_POSITION_SIZE', 1000),
    minPositionSize: getEnvVarAsNumber('MIN_POSITION_SIZE', 10),
    copyRatio: getEnvVarAsNumber('COPY_RATIO', 1.0),
    maxSlippage: getEnvVarAsNumber('MAX_SLIPPAGE', 0.02),
    gasPriceMultiplier: getEnvVarAsNumber('GAS_PRICE_MULTIPLIER', 1.2),
    maxGasPriceGwei: getEnvVarAsNumber('MAX_GAS_PRICE_GWEI', 500),
  },

  performance: {
    // WebSocket reconnection settings (exponential backoff)
    wsReconnectDelay: getEnvVarAsNumber('WS_RECONNECT_DELAY', 1000),
    wsMaxReconnectAttempts: getEnvVarAsNumber('WS_MAX_RECONNECT_ATTEMPTS', 3),
    wsReconnectMaxDelay: getEnvVarAsNumber('WS_RECONNECT_MAX_DELAY', 30000),
    wsHeartbeatInterval: getEnvVarAsNumber('WS_HEARTBEAT_INTERVAL', 30000),
    
    // HTTP polling fallback
    httpPollingInterval: getEnvVarAsNumber('HTTP_POLLING_INTERVAL', 1500),
    httpPollingFallbackAfterAttempts: getEnvVarAsNumber('HTTP_FALLBACK_AFTER', 3),
    wsBackgroundReconnectInterval: getEnvVarAsNumber('WS_BACKGROUND_RECONNECT', 60000),
    
    // RPC settings
    rpcTimeout: getEnvVarAsNumber('RPC_TIMEOUT', 5000),
    nonceCacheTtl: getEnvVarAsNumber('NONCE_CACHE_TTL', 30),
  },

  health: {
    checkInterval: getEnvVarAsNumber('HEALTH_CHECK_INTERVAL', 10000),
    noEventWarningThreshold: getEnvVarAsNumber('NO_EVENT_WARNING_MS', 60000),
    noEventCriticalThreshold: getEnvVarAsNumber('NO_EVENT_CRITICAL_MS', 120000),
    dailyUptimeThreshold: getEnvVarAsNumber('DAILY_UPTIME_THRESHOLD', 95),
  },

  alerts: {
    enabled: getEnvVar('ALERTS_ENABLED', 'true') === 'true',
    webhookUrl: getEnvVar('ALERT_WEBHOOK_URL', ''),
    telegramBotToken: getEnvVar('TELEGRAM_BOT_TOKEN', ''),
    telegramChatId: getEnvVar('TELEGRAM_CHAT_ID', ''),
    discordWebhookUrl: getEnvVar('DISCORD_WEBHOOK_URL', ''),
    emailTo: getEnvVar('ALERT_EMAIL_TO', ''),
  },

  control: {
    killSwitchKey: getEnvVar('KILL_SWITCH_KEY', 'copytrade:kill_switch'),
    pauseKey: getEnvVar('PAUSE_KEY', 'copytrade:paused'),
    configWatchEnabled: getEnvVar('CONFIG_WATCH_ENABLED', 'true') === 'true',
    killSwitchCheckInterval: getEnvVarAsNumber('KILL_SWITCH_CHECK_INTERVAL', 5000),
    dryRunMode: getEnvVar('DRY_RUN_MODE', 'false') === 'true',
    enableConfigWatch: getEnvVar('ENABLE_CONFIG_WATCH', 'false') === 'true',
  },

  logLevel: getEnvVar('LOG_LEVEL', 'info'),
  nodeEnv: getEnvVar('NODE_ENV', 'development'),
};

export default config;
