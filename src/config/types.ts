// Polymarket CLOB API Types

export interface OrderBookUpdate {
  asset_id: string;
  market: string;
  timestamp: string;
  hash: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface Trade {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  fee_rate_bps: string;
  price: string;
  status: 'MATCHED' | 'MINED' | 'CONFIRMED';
  match_time: string;
  last_update: string;
  outcome: string;
  bucket_index: number;
  owner: string;
  maker_address: string;
  transaction_hash?: string;
  trader_side?: 'TAKER' | 'MAKER';
}

export interface Order {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  original_size: string;
  size_matched: string;
  price: string;
  outcome: string;
  owner: string;
  expiration: string;
  status: 'LIVE' | 'MATCHED' | 'CANCELLED';
  created_at: string;
  order_type: 'GTC' | 'FOK' | 'GTD';
}

export interface Market {
  condition_id: string;
  question_id: string;
  tokens: Token[];
  rewards: MarketRewards;
  minimum_order_size: string;
  minimum_tick_size: string;
  description: string;
  category: string;
  end_date_iso: string;
  game_start_time?: string;
  question: string;
  market_slug: string;
  min_incentive_size: string;
  max_incentive_spread: string;
  active: boolean;
  closed: boolean;
  seconds_delay: number;
  icon: string;
  fpmm: string;
}

export interface Token {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

export interface MarketRewards {
  rates: RewardRate[];
  min_size: string;
  max_spread: string;
}

export interface RewardRate {
  asset_address: string;
  rewards_daily_rate: number;
}

// WebSocket Message Types
export interface WSMessage {
  type: string;
  channel?: string;
  message?: string;
  data?: Trade | Order | LiveActivityEvent;
  [key: string]: unknown;
}

export interface WSSubscribeMessage {
  type: 'subscribe';
  channel: 'market' | 'user' | 'live-activity';
  markets?: string[];
  assets_ids?: string[];
  [key: string]: unknown;
}

export interface WSTradeMessage {
  type: 'trade';
  data: Trade;
}

export interface WSOrderMessage {
  type: 'order';
  data: Order;
}

export interface WSLiveActivityMessage {
  type: 'live-activity';
  data: LiveActivityEvent;
}

export interface LiveActivityEvent {
  id: string;
  timestamp: string;
  event_type: 'trade' | 'order' | 'position';
  market: string;
  asset_id: string;
  user: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  outcome: string;
}

// Internal Types
export interface CopyTradeSignal {
  id: string;
  detectedAt: number;
  targetTrade: Trade;
  market: string;
  assetId: string;
  side: 'BUY' | 'SELL';
  originalSize: string;
  calculatedSize: string;
  price: string;
  maxPrice: string;  // with slippage
  status: 'PENDING' | 'EXECUTING' | 'EXECUTED' | 'FAILED';
  executedAt?: number;
  executionLatency?: number;
  error?: string;
}

export interface PositionState {
  assetId: string;
  market: string;
  outcome: string;
  size: string;
  averagePrice: string;
  lastUpdated: number;
}

export interface GasEstimate {
  gasPrice: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  estimatedGas: bigint;
}

export interface NonceState {
  current: number;
  pending: number;
  lastUpdated: number;
}

// Polymarket Order Signing Types
export interface SignedOrder {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: number; // 0 = BUY, 1 = SELL
  signatureType: number;
  signature: string;
}

export interface OrderPayload {
  order: SignedOrder;
  owner: string;
  orderType: 'GTC' | 'FOK' | 'GTD';
}

// Performance Metrics
export interface PerformanceMetrics {
  tradeDetectionLatency: number[];
  orderExecutionLatency: number[];
  endToEndLatency: number[];
  successRate: number;
  totalTradesCopied: number;
  totalTradesFailed: number;
  lastUpdate: number;
}

export interface HealthStatus {
  websocket: 'connected' | 'disconnected' | 'reconnecting';
  blockchainMonitor: 'connected' | 'disconnected' | 'reconnecting';
  primaryRpc: 'healthy' | 'degraded' | 'down';
  failoverRpc: 'healthy' | 'degraded' | 'down';
  redis: 'connected' | 'disconnected';
  mongodb: 'connected' | 'disconnected';
  lastHealthCheck: number;
}

// ===========================================
// BLOCKCHAIN EVENT MONITORING TYPES
// ===========================================

/**
 * Raw Ethereum log from WebSocket subscription
 */
export interface RawEthLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  logIndex: string;
  removed: boolean;
}

/**
 * Parsed OrderFilled event from CTF Exchange
 */
export interface OrderFilledEvent {
  // Event metadata
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: number;
  
  // Indexed parameters (from topics)
  orderHash: string;
  maker: string;
  taker: string;
  
  // Non-indexed parameters (from data)
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: string;
  takerAmountFilled: string;
  fee: string;
  
  // Derived fields
  side: 'BUY' | 'SELL';
  tokenId: string;
  usdcAmount: string;
  tokenAmount: string;
  price: string;
}

/**
 * WebSocket RPC subscription response
 */
export interface WSRPCSubscriptionResponse {
  jsonrpc: '2.0';
  id: number;
  result?: string; // subscription ID
  error?: {
    code: number;
    message: string;
  };
}

/**
 * WebSocket RPC log notification
 */
export interface WSRPCLogNotification {
  jsonrpc: '2.0';
  method: 'eth_subscription';
  params: {
    subscription: string;
    result: RawEthLog;
  };
}

/**
 * Blockchain monitor status
 */
export interface BlockchainMonitorStatus {
  connected: boolean;
  subscriptionId: string | null;
  lastEventTime: number;
  lastBlockNumber: number;
  eventsReceived: number;
  targetEventsDetected: number;
  reconnectAttempts: number;
}

