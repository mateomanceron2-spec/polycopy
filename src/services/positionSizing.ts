/**
 * Position Sizing Service
 * 
 * Handles all position sizing calculations:
 * - Trade size based on target size * multiplier
 * - Balance checks (USDC and MATIC)
 * - Position limits (max % of balance)
 * - Gas reserve requirements
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';
import { getCacheService, CacheService } from './cache.js';
import { getRPCProviderManager, RPCProviderManager } from './rpcProviderManager.js';
import { getAlertService, AlertService } from './alertService.js';
import { POLYMARKET_CONTRACTS } from '../config/constants.js';

const logger = createChildLogger('PositionSizing');

export interface WalletBalance {
  usdc: bigint;
  usdcFormatted: number;
  matic: bigint;
  maticFormatted: number;
  lastUpdated: number;
}

export interface PositionSizeResult {
  valid: boolean;
  originalSize: number;
  calculatedSize: number;
  reason?: string;
  balanceAfterTrade?: number;
  maticBalance?: number;
}

export class PositionSizingService extends EventEmitter {
  private cacheService: CacheService;
  private rpcManager: RPCProviderManager;
  private alertService: AlertService;
  
  // Cached balance
  private walletBalance: WalletBalance | null = null;
  private balanceUpdateInterval: NodeJS.Timeout | null = null;
  
  // Constants
  private readonly USDC_DECIMALS = 6;
  private readonly MATIC_DECIMALS = 18;
  private readonly BALANCE_CACHE_TTL = 30000; // 30 seconds
  private readonly BALANCE_UPDATE_INTERVAL = 60000; // 60 seconds background update
  private readonly LOW_BALANCE_ALERT_MULTIPLIER = 3; // Alert if balance < minTradeSize * 3

  constructor() {
    super();
    this.cacheService = getCacheService();
    this.rpcManager = getRPCProviderManager();
    this.alertService = getAlertService();
  }

  /**
   * Start the position sizing service
   */
  async start(walletAddress: string): Promise<void> {
    logger.info('Starting position sizing service');
    
    // Initial balance fetch
    await this.updateWalletBalance(walletAddress);
    
    // Start background balance updates
    this.balanceUpdateInterval = setInterval(async () => {
      try {
        await this.updateWalletBalance(walletAddress);
      } catch (error) {
        logger.error({ error }, 'Background balance update failed');
      }
    }, this.BALANCE_UPDATE_INTERVAL);
  }

  /**
   * Stop the service
   */
  stop(): void {
    if (this.balanceUpdateInterval) {
      clearInterval(this.balanceUpdateInterval);
      this.balanceUpdateInterval = null;
    }
  }

  /**
   * Update wallet balance from blockchain
   */
  async updateWalletBalance(walletAddress: string): Promise<WalletBalance> {
    // In dry-run mode, return simulated balance
    if (process.env.DRY_RUN_MODE === 'true') {
      this.walletBalance = {
        usdc: BigInt(1000 * Math.pow(10, this.USDC_DECIMALS)), // 1000 USDC
        usdcFormatted: 1000,
        matic: BigInt(10 * Math.pow(10, this.MATIC_DECIMALS)), // 10 MATIC
        maticFormatted: 10,
        lastUpdated: Date.now(),
      };
      return this.walletBalance;
    }
    
    const provider = this.rpcManager.getHttpProvider();
    
    try {
      // Get USDC balance
      const usdcBalanceHex = await provider.call({
        to: POLYMARKET_CONTRACTS.USDC,
        data: `0x70a08231000000000000000000000000${walletAddress.slice(2).toLowerCase()}`,
      });
      const usdcBalance = BigInt(usdcBalanceHex);
      const usdcFormatted = Number(usdcBalance) / Math.pow(10, this.USDC_DECIMALS);

      // Get MATIC balance
      const maticBalance = await provider.getBalance(walletAddress);
      const maticFormatted = Number(maticBalance) / Math.pow(10, this.MATIC_DECIMALS);

      this.walletBalance = {
        usdc: usdcBalance,
        usdcFormatted,
        matic: maticBalance,
        maticFormatted,
        lastUpdated: Date.now(),
      };

      // Cache the balance
      await this.cacheService.setWalletBalance(walletAddress, {
        usdc: usdcBalance.toString(),
        matic: maticBalance.toString(),
      });

      // Check for low balance alerts
      await this.checkBalanceAlerts(usdcFormatted, maticFormatted);

      logger.debug({
        usdc: usdcFormatted.toFixed(2),
        matic: maticFormatted.toFixed(4),
      }, 'Wallet balance updated');

      return this.walletBalance;
    } catch (error) {
      logger.error({ error }, 'Failed to update wallet balance');
      throw error;
    }
  }

  /**
   * Get current wallet balance (from cache or fetch)
   */
  async getWalletBalance(walletAddress: string): Promise<WalletBalance> {
    // In dry-run mode, return simulated balance
    if (process.env.DRY_RUN_MODE === 'true') {
      const simulatedBalance = {
        usdc: BigInt(1000 * Math.pow(10, this.USDC_DECIMALS)), // 1000 USDC
        usdcFormatted: 1000,
        matic: BigInt(10 * Math.pow(10, this.MATIC_DECIMALS)), // 10 MATIC
        maticFormatted: 10,
        lastUpdated: Date.now(),
      };
      this.walletBalance = simulatedBalance;
      return simulatedBalance;
    }
    
    // Check if cached balance is still valid
    if (this.walletBalance && 
        Date.now() - this.walletBalance.lastUpdated < this.BALANCE_CACHE_TTL) {
      return this.walletBalance;
    }

    // Try to get from Redis cache first
    const cached = await this.cacheService.getWalletBalance(walletAddress);
    if (cached) {
      this.walletBalance = {
        usdc: BigInt(cached.usdc),
        usdcFormatted: Number(cached.usdc) / Math.pow(10, this.USDC_DECIMALS),
        matic: BigInt(cached.matic),
        maticFormatted: Number(cached.matic) / Math.pow(10, this.MATIC_DECIMALS),
        lastUpdated: cached.lastUpdated,
      };
      
      // If cache is fresh enough, use it
      if (Date.now() - cached.lastUpdated < this.BALANCE_CACHE_TTL) {
        return this.walletBalance;
      }
    }

    // Fetch fresh balance
    return this.updateWalletBalance(walletAddress);
  }

  /**
   * Calculate position size for a copy trade
   */
  async calculatePositionSize(
    walletAddress: string,
    targetSizeUsdc: number
  ): Promise<PositionSizeResult> {
    const startTime = Date.now();
    
    try {
      // Get current balance
      const balance = await this.getWalletBalance(walletAddress);
      
      // Step 1: Calculate base size from target
      let calculatedSize = targetSizeUsdc * config.trading.tradeMultiplier;
      
      // Step 2: Check minimum trade size
      if (calculatedSize < config.trading.minTradeSize) {
        logger.debug({
          calculatedSize,
          minSize: config.trading.minTradeSize,
        }, 'Trade below minimum size');
        
        return {
          valid: false,
          originalSize: targetSizeUsdc,
          calculatedSize,
          reason: `Trade size $${calculatedSize.toFixed(2)} below minimum $${config.trading.minTradeSize}`,
        };
      }

      // Step 3: Check max position percent
      const maxAllowedSize = balance.usdcFormatted * (config.trading.maxPositionPercent / 100);
      if (calculatedSize > maxAllowedSize) {
        logger.info({
          calculatedSize,
          maxAllowedSize,
          maxPercent: config.trading.maxPositionPercent,
        }, 'Capping position size to max percent');
        
        calculatedSize = maxAllowedSize;
      }

      // Step 4: Check remaining balance after trade
      const balanceAfterTrade = balance.usdcFormatted - calculatedSize;
      
      // Step 5: Check gas reserve (MATIC balance check)
      // Note: minGasReserve is in MATIC units
      if (balance.maticFormatted < config.trading.minGasReserve) {
        logger.warn({
          maticBalance: balance.maticFormatted,
          minRequired: config.trading.minGasReserve,
        }, 'Insufficient MATIC for gas');
        
        return {
          valid: false,
          originalSize: targetSizeUsdc,
          calculatedSize,
          reason: `Insufficient MATIC for gas: ${balance.maticFormatted.toFixed(4)} < ${config.trading.minGasReserve}`,
          maticBalance: balance.maticFormatted,
        };
      }

      // Step 6: Check if we have enough USDC
      if (calculatedSize > balance.usdcFormatted) {
        logger.warn({
          calculatedSize,
          available: balance.usdcFormatted,
        }, 'Insufficient USDC balance');
        
        return {
          valid: false,
          originalSize: targetSizeUsdc,
          calculatedSize,
          reason: `Insufficient USDC: need $${calculatedSize.toFixed(2)}, have $${balance.usdcFormatted.toFixed(2)}`,
          balanceAfterTrade: balance.usdcFormatted - calculatedSize,
        };
      }

      // All checks passed
      const latency = Date.now() - startTime;
      logger.debug({
        targetSize: targetSizeUsdc,
        calculatedSize,
        balanceAfterTrade,
        latency,
      }, 'Position size calculated');

      return {
        valid: true,
        originalSize: targetSizeUsdc,
        calculatedSize,
        balanceAfterTrade,
        maticBalance: balance.maticFormatted,
      };

    } catch (error) {
      logger.error({ error }, 'Position sizing calculation failed');
      
      return {
        valid: false,
        originalSize: targetSizeUsdc,
        calculatedSize: 0,
        reason: `Position sizing error: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Check for low balance and send alerts
   */
  private async checkBalanceAlerts(usdcBalance: number, maticBalance: number): Promise<void> {
    // Check USDC balance
    const minUsdcAlert = config.trading.minTradeSize * this.LOW_BALANCE_ALERT_MULTIPLIER;
    if (usdcBalance < minUsdcAlert) {
      await this.alertService.sendAlert(
        'health_check',
        'warning',
        `Low USDC balance: $${usdcBalance.toFixed(2)} (minimum for 3 trades: $${minUsdcAlert.toFixed(2)})`,
        { usdcBalance, threshold: minUsdcAlert }
      );
    }

    // Check MATIC balance
    if (maticBalance < config.trading.minGasReserve) {
      await this.alertService.sendAlert(
        'health_check',
        'critical',
        `Low MATIC balance: ${maticBalance.toFixed(4)} MATIC (minimum: ${config.trading.minGasReserve} MATIC)`,
        { maticBalance, minRequired: config.trading.minGasReserve }
      );
    }
  }

  /**
   * Get current cached balance (without fetching)
   */
  getCachedBalance(): WalletBalance | null {
    return this.walletBalance;
  }

  /**
   * Force refresh balance
   */
  async refreshBalance(walletAddress: string): Promise<WalletBalance> {
    return this.updateWalletBalance(walletAddress);
  }

  /**
   * Stop background balance updates
   */
  stopBackgroundUpdates(): void {
    if (this.balanceUpdateInterval) {
      clearInterval(this.balanceUpdateInterval);
      this.balanceUpdateInterval = null;
    }
    logger.debug('Background balance updates stopped');
  }
}

// Singleton
let instance: PositionSizingService | null = null;

export function getPositionSizing(): PositionSizingService {
  if (!instance) {
    instance = new PositionSizingService();
  }
  return instance;
}

export function getPositionSizingService(): PositionSizingService {
  return getPositionSizing();
}

export default PositionSizingService;
