/**
 * Trade Validator Service
 * 
 * Handles all trade validation:
 * - Duplicate detection (orderHash check)
 * - Market cooldown enforcement
 * - Slippage validation
 * - Market status verification
 * - Whitelist/Blacklist filtering
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';
import { getCacheService, CacheService } from './cache.js';
import type { OrderFilledEvent } from '../config/types.js';

const logger = createChildLogger('TradeValidator');

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  adjustedPrice?: number;
  warnings?: string[];
}

export interface MarketPrice {
  tokenId: string;
  price: number;
  lastUpdated: number;
}

export class TradeValidatorService extends EventEmitter {
  private cacheService: CacheService;
  
  // In-memory caches for fast lookup
  private processedOrderHashes: Map<string, number> = new Map(); // orderHash -> timestamp
  private marketLastTradeTime: Map<string, number> = new Map(); // market -> last trade time
  private marketPrices: Map<string, MarketPrice> = new Map(); // tokenId -> price data
  private marketStatuses: Map<string, { active: boolean; closed: boolean }> = new Map();
  
  // Constants
  private readonly ORDER_HASH_TTL = 3600000; // 1 hour
  private readonly MAX_PROCESSED_HASHES = 10000;
  private readonly PRICE_STALE_THRESHOLD = 30000; // 30 seconds

  constructor() {
    super();
    this.cacheService = getCacheService();
  }

  /**
   * Validate a trade before execution
   */
  async validateTrade(
    event: OrderFilledEvent,
    currentMarketPrice?: number
  ): Promise<ValidationResult> {
    const startTime = Date.now();
    const warnings: string[] = [];
    
    try {
      // 1. Check for duplicate orderHash
      const duplicateCheck = await this.checkDuplicateOrder(event.orderHash);
      if (!duplicateCheck.valid) {
        return duplicateCheck;
      }

      // 2. Check market whitelist/blacklist
      const marketFilterCheck = this.checkMarketFilters(event.tokenId);
      if (!marketFilterCheck.valid) {
        return marketFilterCheck;
      }

      // 3. Check market cooldown
      const cooldownCheck = this.checkMarketCooldown(event.tokenId);
      if (!cooldownCheck.valid) {
        return cooldownCheck;
      }

      // 4. Check market status (if available)
      const statusCheck = this.checkMarketStatus(event.tokenId);
      if (!statusCheck.valid) {
        return statusCheck;
      }

      // 5. Check slippage (if we have current price)
      let adjustedPrice: number | undefined;
      if (currentMarketPrice !== undefined) {
        const slippageCheck = this.checkSlippage(
          parseFloat(event.price),
          currentMarketPrice,
          event.side
        );
        
        if (!slippageCheck.valid) {
          // Option: Skip trade OR adjust price
          if (config.trading.maxSlippagePercent > 0) {
            // Adjust price instead of skipping
            adjustedPrice = slippageCheck.adjustedPrice;
            warnings.push(`Price adjusted due to slippage: ${event.price} → ${adjustedPrice?.toFixed(4)}`);
          } else {
            return slippageCheck;
          }
        }
      }

      const latency = Date.now() - startTime;
      logger.debug({
        orderHash: event.orderHash.slice(0, 18),
        latency,
        warnings: warnings.length,
      }, 'Trade validation passed');

      return {
        valid: true,
        adjustedPrice,
        warnings: warnings.length > 0 ? warnings : undefined,
      };

    } catch (error) {
      logger.error({ error, orderHash: event.orderHash }, 'Trade validation error');
      
      return {
        valid: false,
        reason: `Validation error: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Check if orderHash has already been processed
   */
  private async checkDuplicateOrder(orderHash: string): Promise<ValidationResult> {
    // Check in-memory cache first (fastest)
    if (this.processedOrderHashes.has(orderHash)) {
      logger.debug({ orderHash: orderHash.slice(0, 18) }, 'Duplicate order detected (memory)');
      return {
        valid: false,
        reason: 'Duplicate order: already processed',
      };
    }

    // Check Redis cache
    try {
      const cached = await this.cacheService.getPendingOrder(orderHash);
      if (cached) {
        logger.debug({ orderHash: orderHash.slice(0, 18) }, 'Duplicate order detected (Redis)');
        return {
          valid: false,
          reason: 'Duplicate order: already in cache',
        };
      }
    } catch {
      // Redis unavailable, rely on memory cache
    }

    return { valid: true };
  }

  /**
   * Check market whitelist and blacklist
   */
  private checkMarketFilters(tokenId: string): ValidationResult {
    // Check whitelist (if configured)
    if (config.trading.marketWhitelist.length > 0) {
      if (!config.trading.marketWhitelist.includes(tokenId)) {
        logger.debug({ tokenId: tokenId.slice(0, 18) }, 'Market not in whitelist');
        return {
          valid: false,
          reason: 'Market not in whitelist',
        };
      }
    }

    // Check blacklist
    if (config.trading.marketBlacklist.length > 0) {
      if (config.trading.marketBlacklist.includes(tokenId)) {
        logger.debug({ tokenId: tokenId.slice(0, 18) }, 'Market in blacklist');
        return {
          valid: false,
          reason: 'Market is blacklisted',
        };
      }
    }

    return { valid: true };
  }

  /**
   * Check market cooldown (prevent rapid trading in same market)
   */
  private checkMarketCooldown(tokenId: string): ValidationResult {
    const lastTradeTime = this.marketLastTradeTime.get(tokenId);
    
    if (lastTradeTime) {
      const timeSinceLastTrade = Date.now() - lastTradeTime;
      const cooldownMs = config.trading.marketCooldownSeconds * 1000;
      
      if (timeSinceLastTrade < cooldownMs) {
        const remainingSeconds = Math.ceil((cooldownMs - timeSinceLastTrade) / 1000);
        logger.debug({
          tokenId: tokenId.slice(0, 18),
          remainingSeconds,
        }, 'Market on cooldown');
        
        return {
          valid: false,
          reason: `Market cooldown: ${remainingSeconds}s remaining`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Check if market is still active
   */
  private checkMarketStatus(tokenId: string): ValidationResult {
    const status = this.marketStatuses.get(tokenId);
    
    if (status) {
      if (status.closed) {
        return {
          valid: false,
          reason: 'Market is closed',
        };
      }
      
      if (!status.active) {
        return {
          valid: false,
          reason: 'Market is not active',
        };
      }
    }

    // If no status cached, allow the trade (market API will reject if invalid)
    return { valid: true };
  }

  /**
   * Check slippage and potentially adjust price
   */
  private checkSlippage(
    targetPrice: number,
    currentPrice: number,
    side: 'BUY' | 'SELL'
  ): ValidationResult {
    const slippage = Math.abs(targetPrice - currentPrice) / targetPrice * 100;
    
    if (slippage > config.trading.maxSlippagePercent) {
      logger.warn({
        targetPrice,
        currentPrice,
        slippage: slippage.toFixed(2) + '%',
        maxAllowed: config.trading.maxSlippagePercent + '%',
      }, 'Slippage exceeds maximum');

      // Calculate adjusted price within slippage bounds
      const pricePremium = config.trading.pricePremiumCents / 100;
      let adjustedPrice: number;
      
      if (side === 'BUY') {
        // For BUY, add premium to increase chances of fill
        adjustedPrice = Math.min(
          currentPrice + pricePremium,
          targetPrice * (1 + config.trading.maxSlippagePercent / 100)
        );
      } else {
        // For SELL, subtract premium
        adjustedPrice = Math.max(
          currentPrice - pricePremium,
          targetPrice * (1 - config.trading.maxSlippagePercent / 100)
        );
      }

      return {
        valid: false,
        reason: `Slippage ${slippage.toFixed(2)}% exceeds max ${config.trading.maxSlippagePercent}%`,
        adjustedPrice,
      };
    }

    return { valid: true };
  }

  /**
   * Mark an order as processed
   */
  async markOrderProcessed(orderHash: string): Promise<void> {
    // Add to memory cache
    this.processedOrderHashes.set(orderHash, Date.now());
    this.maintainOrderHashCache();

    // Add to Redis cache with 1 hour TTL
    try {
      await this.cacheService.addPendingOrder(orderHash, {
        processedAt: Date.now(),
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to cache order in Redis');
    }
  }

  /**
   * Update market last trade time
   */
  updateMarketLastTrade(tokenId: string): void {
    this.marketLastTradeTime.set(tokenId, Date.now());
  }

  /**
   * Update market price cache
   */
  updateMarketPrice(tokenId: string, price: number): void {
    this.marketPrices.set(tokenId, {
      tokenId,
      price,
      lastUpdated: Date.now(),
    });
  }

  /**
   * Get cached market price
   */
  getMarketPrice(tokenId: string): number | undefined {
    const cached = this.marketPrices.get(tokenId);
    
    if (cached && Date.now() - cached.lastUpdated < this.PRICE_STALE_THRESHOLD) {
      return cached.price;
    }

    return undefined;
  }

  /**
   * Update market status cache
   */
  updateMarketStatus(tokenId: string, active: boolean, closed: boolean): void {
    this.marketStatuses.set(tokenId, { active, closed });
  }

  /**
   * Maintain order hash cache size
   */
  private maintainOrderHashCache(): void {
    if (this.processedOrderHashes.size > this.MAX_PROCESSED_HASHES) {
      // Remove oldest entries
      const entries = Array.from(this.processedOrderHashes.entries())
        .sort((a, b) => a[1] - b[1]);
      
      const toRemove = entries.slice(0, this.MAX_PROCESSED_HASHES / 2);
      for (const [hash] of toRemove) {
        this.processedOrderHashes.delete(hash);
      }
    }

    // Also remove expired entries
    const now = Date.now();
    for (const [hash, timestamp] of this.processedOrderHashes) {
      if (now - timestamp > this.ORDER_HASH_TTL) {
        this.processedOrderHashes.delete(hash);
      }
    }
  }

  /**
   * Clear all cooldowns (for testing)
   */
  clearCooldowns(): void {
    this.marketLastTradeTime.clear();
  }

  /**
   * Clear all caches
   */
  clearAll(): void {
    this.processedOrderHashes.clear();
    this.marketLastTradeTime.clear();
    this.marketPrices.clear();
    this.marketStatuses.clear();
  }

  /**
   * Get validation statistics
   */
  getStats(): {
    processedOrders: number;
    marketsOnCooldown: number;
    cachedPrices: number;
  } {
    const now = Date.now();
    const cooldownMs = config.trading.marketCooldownSeconds * 1000;
    
    let marketsOnCooldown = 0;
    for (const [, timestamp] of this.marketLastTradeTime) {
      if (now - timestamp < cooldownMs) {
        marketsOnCooldown++;
      }
    }

    return {
      processedOrders: this.processedOrderHashes.size,
      marketsOnCooldown,
      cachedPrices: this.marketPrices.size,
    };
  }
}

// Singleton
let instance: TradeValidatorService | null = null;

export function getTradeValidator(): TradeValidatorService {
  if (!instance) {
    instance = new TradeValidatorService();
  }
  return instance;
}

export default TradeValidatorService;
