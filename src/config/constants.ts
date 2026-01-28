// Polymarket Contract Addresses and Constants

// Polygon Mainnet Addresses
export const POLYGON_CHAIN_ID = 137;

// Polymarket Contract Addresses
export const POLYMARKET_CONTRACTS = {
  // CTF Exchange (Conditional Token Framework)
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  
  // Neg Risk CTF Exchange
  NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  
  // Neg Risk Adapter
  NEG_RISK_ADAPTER: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  
  // Conditional Tokens
  CONDITIONAL_TOKENS: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  
  // USDC on Polygon
  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  
  // USDC.e (Bridged USDC)
  USDC_E: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
} as const;

// EIP-712 Domain for Order Signing
export const EIP712_DOMAIN = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: POLYGON_CHAIN_ID,
  verifyingContract: POLYMARKET_CONTRACTS.CTF_EXCHANGE,
} as const;

// Order Types for EIP-712 Signing
export const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
} as const;

// Order Side Constants
export const ORDER_SIDE = {
  BUY: 0,
  SELL: 1,
} as const;

// Signature Types
export const SIGNATURE_TYPE = {
  EOA: 0,
  POLY_PROXY: 1,
  POLY_GNOSIS_SAFE: 2,
} as const;

// Fee Rate (in basis points)
export const DEFAULT_FEE_RATE_BPS = '0';

// Order Expiration (default: 1 day from now)
export const DEFAULT_ORDER_EXPIRATION_SECONDS = 86400;

// Minimum amounts
export const MIN_ORDER_SIZE_USDC = '1'; // 1 USDC minimum
export const MIN_TICK_SIZE = '0.01'; // 1 cent tick size

// WebSocket Channels
export const WS_CHANNELS = {
  MARKET: 'market',
  USER: 'user',
  LIVE_ACTIVITY: 'live-activity',
} as const;

// API Endpoints
export const API_ENDPOINTS = {
  ORDERS: '/orders',
  MARKETS: '/markets',
  BOOK: '/book',
  TRADES: '/trades',
  POSITIONS: '/positions',
} as const;

// Rate Limiting
export const RATE_LIMITS = {
  ORDERS_PER_SECOND: 10,
  REQUESTS_PER_MINUTE: 300,
} as const;

// Retry Configuration
export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 100,
  MAX_DELAY_MS: 5000,
  BACKOFF_MULTIPLIER: 2,
} as const;

// Cache Keys (Redis)
export const CACHE_KEYS = {
  NONCE: 'nonce:',
  POSITION: 'position:',
  MARKET: 'market:',
  PENDING_ORDER: 'pending_order:',
  GAS_PRICE: 'gas_price',
  HEALTH: 'health_status',
  WALLET_BALANCE: 'wallet_balance:',
  RPC_STATUS: 'rpc_status',
  CONTRACT_ABI: 'contract_abi:',
} as const;

// Cache TTLs (in seconds)
export const CACHE_TTL = {
  NONCE: 30,
  POSITION: 60,
  MARKET: 300,           // 5 minutes for market metadata
  GAS_PRICE: 10,
  HEALTH: 5,
  WALLET_BALANCE: 30,    // 30 seconds for wallet balance
  RPC_STATUS: 10,
} as const;

// MongoDB Collections
export const MONGODB_COLLECTIONS = {
  TRADES: 'trades',
  ORDERS: 'orders',
  POSITIONS: 'positions',
  METRICS: 'metrics',
  ERRORS: 'errors',
} as const;

// ===========================================
// BLOCKCHAIN EVENT MONITORING
// ===========================================

// CTF Exchange Event Signatures (keccak256 hashes)
// OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)
export const EVENT_SIGNATURES = {
  // OrderFilled event on CTF Exchange
  ORDER_FILLED: '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6',
  
  // OrdersMatched event (alternative event)
  ORDERS_MATCHED: '0x63bf4d16b7fa898ef4c4b2b6d90fd201e9c56313b65638af6088d149d2ce956c',
  
  // Trade event on Neg Risk CTF Exchange
  NEG_RISK_ORDER_FILLED: '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6',
} as const;

// Event ABIs for decoding
export const EVENT_ABIS = {
  ORDER_FILLED: [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
  ],
  ORDERS_MATCHED: [
    'event OrdersMatched(bytes32 indexed takerOrderHash, address indexed takerOrderMaker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled)',
  ],
} as const;

// WebSocket RPC Configuration
export const WS_RPC_CONFIG = {
  // Heartbeat interval (30 seconds as recommended)
  HEARTBEAT_INTERVAL: 30000,
  
  // Reconnection settings
  RECONNECT_BASE_DELAY: 1000,
  RECONNECT_MAX_DELAY: 30000,
  
  // Health monitoring
  NO_EVENT_ALERT_THRESHOLD: 60000, // Alert if no events for 60 seconds
  
  // Subscription confirmation timeout
  SUBSCRIPTION_TIMEOUT: 10000,
} as const;

// USDC Token ID (for identifying USDC in trades)
// This is used to determine trade side - if makerAssetId is USDC, it's a BUY
export const USDC_CONDITIONAL_TOKEN_ID = '0'; // Placeholder - USDC is not a conditional token
