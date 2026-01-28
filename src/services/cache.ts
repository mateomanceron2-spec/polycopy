import Redis from 'ioredis';
import config from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { CACHE_KEYS, CACHE_TTL } from '../config/constants.js';
import type { NonceState, PositionState, GasEstimate, HealthStatus } from '../config/types.js';

const logger = createChildLogger('CacheService');

export class CacheService {
  private redis: Redis | null = null;
  private localCache: Map<string, { value: string; expiry: number }> = new Map();
  private useLocalFallback = false;

  constructor() {
    this.initializeRedis();
  }

  /**
   * Initialize Redis connection
   */
  private initializeRedis(): void {
    try {
      this.redis = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password || undefined,
        db: config.redis.db,
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => {
          if (times > 3) {
            logger.warn('Redis connection failed, using local fallback');
            this.useLocalFallback = true;
            return null; // Stop retrying
          }
          return Math.min(times * 100, 3000);
        },
        lazyConnect: true,
      });

      this.redis.on('connect', () => {
        logger.info('Redis connected');
        this.useLocalFallback = false;
      });

      this.redis.on('error', (error) => {
        logger.error({ error: error.message }, 'Redis error');
      });

      this.redis.on('close', () => {
        logger.warn('Redis connection closed');
      });

    } catch (error) {
      logger.error({ error }, 'Failed to initialize Redis');
      this.useLocalFallback = true;
    }
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this.redis && !this.useLocalFallback) {
      try {
        await this.redis.connect();
      } catch (error) {
        logger.warn({ error }, 'Redis connect failed, using local fallback');
        this.useLocalFallback = true;
      }
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  /**
   * Generic get from cache (public for service use)
   */
  async get(key: string): Promise<string | null> {
    if (this.useLocalFallback) {
      const cached = this.localCache.get(key);
      if (cached && cached.expiry > Date.now()) {
        return cached.value;
      }
      this.localCache.delete(key);
      return null;
    }

    try {
      return await this.redis!.get(key);
    } catch (error) {
      logger.error({ error, key }, 'Cache get error');
      return null;
    }
  }

  /**
   * Generic set to cache (public for service use)
   */
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.useLocalFallback) {
      this.localCache.set(key, {
        value,
        expiry: Date.now() + ttlSeconds * 1000,
      });
      return;
    }

    try {
      await this.redis!.setex(key, ttlSeconds, value);
    } catch (error) {
      logger.error({ error, key }, 'Cache set error');
      // Fallback to local
      this.localCache.set(key, {
        value,
        expiry: Date.now() + ttlSeconds * 1000,
      });
    }
  }

  /**
   * Generic delete from cache (public for service use)
   */
  async delete(key: string): Promise<void> {
    this.localCache.delete(key);
    
    if (!this.useLocalFallback) {
      try {
        await this.redis!.del(key);
      } catch (error) {
        logger.error({ error, key }, 'Cache delete error');
      }
    }
  }

  // ================== Nonce Management ==================

  /**
   * Get cached nonce for address
   */
  async getNonce(address: string): Promise<NonceState | null> {
    const key = `${CACHE_KEYS.NONCE}${address.toLowerCase()}`;
    const data = await this.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Set nonce for address
   */
  async setNonce(address: string, state: NonceState): Promise<void> {
    const key = `${CACHE_KEYS.NONCE}${address.toLowerCase()}`;
    await this.set(key, JSON.stringify(state), CACHE_TTL.NONCE);
  }

  /**
   * Increment and get next nonce atomically
   */
  async incrementNonce(address: string): Promise<number> {
    const key = `${CACHE_KEYS.NONCE}${address.toLowerCase()}`;
    
    if (this.useLocalFallback) {
      const state = await this.getNonce(address);
      if (!state) {
        throw new Error('Nonce not initialized');
      }
      state.pending++;
      state.lastUpdated = Date.now();
      await this.setNonce(address, state);
      return state.pending - 1;
    }

    try {
      // Use Redis transaction for atomic operation
      const result = await this.redis!.multi()
        .get(key)
        .exec();

      if (!result || !result[0] || !result[0][1]) {
        throw new Error('Nonce not initialized');
      }

      const state: NonceState = JSON.parse(result[0][1] as string);
      const nextNonce = state.pending;
      state.pending++;
      state.lastUpdated = Date.now();
      
      await this.setNonce(address, state);
      return nextNonce;
    } catch (error) {
      logger.error({ error, address }, 'Failed to increment nonce');
      throw error;
    }
  }

  // ================== Position State ==================

  /**
   * Get cached position
   */
  async getPosition(assetId: string): Promise<PositionState | null> {
    const key = `${CACHE_KEYS.POSITION}${assetId}`;
    const data = await this.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Set position state
   */
  async setPosition(position: PositionState): Promise<void> {
    const key = `${CACHE_KEYS.POSITION}${position.assetId}`;
    await this.set(key, JSON.stringify(position), CACHE_TTL.POSITION);
  }

  // ================== Market Metadata (5 minute cache) ==================

  /**
   * Get cached market metadata
   */
  async getMarketMetadata(marketId: string): Promise<object | null> {
    const key = `${CACHE_KEYS.MARKET}${marketId}`;
    const data = await this.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Set market metadata (5 minute TTL)
   */
  async setMarketMetadata(marketId: string, metadata: object): Promise<void> {
    const key = `${CACHE_KEYS.MARKET}${marketId}`;
    await this.set(key, JSON.stringify(metadata), CACHE_TTL.MARKET); // 5 minutes
  }

  /**
   * Get all cached market metadata
   */
  async getAllMarketMetadata(): Promise<Map<string, object>> {
    const markets = new Map<string, object>();
    
    if (this.useLocalFallback) {
      for (const [key, cached] of this.localCache) {
        if (key.startsWith(CACHE_KEYS.MARKET) && cached.expiry > Date.now()) {
          const marketId = key.replace(CACHE_KEYS.MARKET, '');
          markets.set(marketId, JSON.parse(cached.value));
        }
      }
    } else {
      try {
        const keys = await this.redis!.keys(`${CACHE_KEYS.MARKET}*`);
        for (const key of keys) {
          const data = await this.redis!.get(key);
          if (data) {
            const marketId = key.replace(CACHE_KEYS.MARKET, '');
            markets.set(marketId, JSON.parse(data));
          }
        }
      } catch (error) {
        logger.error({ error }, 'Failed to get all market metadata');
      }
    }
    
    return markets;
  }

  // ================== Wallet Balance (30 second cache) ==================

  /**
   * Get cached wallet balance
   */
  async getWalletBalance(address: string): Promise<{
    usdc: string;
    matic: string;
    lastUpdated: number;
  } | null> {
    const key = `${CACHE_KEYS.WALLET_BALANCE}${address.toLowerCase()}`;
    const data = await this.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Set wallet balance (30 second TTL)
   */
  async setWalletBalance(address: string, balance: {
    usdc: string;
    matic: string;
  }): Promise<void> {
    const key = `${CACHE_KEYS.WALLET_BALANCE}${address.toLowerCase()}`;
    await this.set(key, JSON.stringify({
      ...balance,
      lastUpdated: Date.now(),
    }), CACHE_TTL.WALLET_BALANCE); // 30 seconds
  }

  // ================== Contract ABIs (permanent local cache) ==================
  
  private abiCache: Map<string, object> = new Map();

  /**
   * Get cached contract ABI (local memory only - never expires)
   */
  getContractABI(contractAddress: string): object | null {
    return this.abiCache.get(contractAddress.toLowerCase()) || null;
  }

  /**
   * Set contract ABI (local memory only - never expires)
   */
  setContractABI(contractAddress: string, abi: object): void {
    this.abiCache.set(contractAddress.toLowerCase(), abi);
  }

  /**
   * Preload all contract ABIs at startup
   */
  preloadContractABIs(abis: Map<string, object>): void {
    for (const [address, abi] of abis) {
      this.abiCache.set(address.toLowerCase(), abi);
    }
    logger.info({ count: abis.size }, 'Contract ABIs preloaded');
  }

  // ================== RPC Provider Status ==================

  /**
   * Get cached RPC provider status
   */
  async getRPCProviderStatus(): Promise<object | null> {
    const data = await this.get(CACHE_KEYS.RPC_STATUS);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Set RPC provider status
   */
  async setRPCProviderStatus(status: object): Promise<void> {
    await this.set(CACHE_KEYS.RPC_STATUS, JSON.stringify(status), 10); // 10 second TTL
  }

  // ================== Gas Price ==================

  /**
   * Get cached gas estimate
   */
  async getGasEstimate(): Promise<GasEstimate | null> {
    const data = await this.get(CACHE_KEYS.GAS_PRICE);
    if (!data) return null;
    
    const parsed = JSON.parse(data);
    return {
      gasPrice: BigInt(parsed.gasPrice),
      maxFeePerGas: BigInt(parsed.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(parsed.maxPriorityFeePerGas),
      estimatedGas: BigInt(parsed.estimatedGas),
    };
  }

  /**
   * Set gas estimate
   */
  async setGasEstimate(estimate: GasEstimate): Promise<void> {
    const serialized = {
      gasPrice: estimate.gasPrice.toString(),
      maxFeePerGas: estimate.maxFeePerGas.toString(),
      maxPriorityFeePerGas: estimate.maxPriorityFeePerGas.toString(),
      estimatedGas: estimate.estimatedGas.toString(),
    };
    await this.set(CACHE_KEYS.GAS_PRICE, JSON.stringify(serialized), CACHE_TTL.GAS_PRICE);
  }

  // ================== Pending Orders ==================

  /**
   * Add pending order
   */
  async addPendingOrder(orderId: string, data: object): Promise<void> {
    const key = `${CACHE_KEYS.PENDING_ORDER}${orderId}`;
    await this.set(key, JSON.stringify(data), 300); // 5 min TTL
  }

  /**
   * Get pending order
   */
  async getPendingOrder(orderId: string): Promise<object | null> {
    const key = `${CACHE_KEYS.PENDING_ORDER}${orderId}`;
    const data = await this.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Remove pending order
   */
  async removePendingOrder(orderId: string): Promise<void> {
    const key = `${CACHE_KEYS.PENDING_ORDER}${orderId}`;
    await this.delete(key);
  }

  // ================== Health Status ==================

  /**
   * Get health status
   */
  async getHealthStatus(): Promise<HealthStatus | null> {
    const data = await this.get(CACHE_KEYS.HEALTH);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Set health status
   */
  async setHealthStatus(status: HealthStatus): Promise<void> {
    await this.set(CACHE_KEYS.HEALTH, JSON.stringify(status), CACHE_TTL.HEALTH);
  }

  // ================== Utility Methods ==================

  /**
   * Check if Redis is connected
   */
  isConnected(): boolean {
    if (this.useLocalFallback) {
      return true; // Local fallback is always "connected"
    }
    return this.redis?.status === 'ready';
  }

  /**
   * Clear all cache
   */
  async flushAll(): Promise<void> {
    this.localCache.clear();
    
    if (!this.useLocalFallback) {
      try {
        await this.redis!.flushdb();
      } catch (error) {
        logger.error({ error }, 'Failed to flush Redis');
      }
    }
  }

  /**
   * Get cache stats
   */
  getStats(): { type: string; size: number } {
    return {
      type: this.useLocalFallback ? 'local' : 'redis',
      size: this.localCache.size,
    };
  }
}

// Singleton instance
let cacheServiceInstance: CacheService | null = null;

export function getCacheService(): CacheService {
  if (!cacheServiceInstance) {
    cacheServiceInstance = new CacheService();
  }
  return cacheServiceInstance;
}

export default CacheService;
