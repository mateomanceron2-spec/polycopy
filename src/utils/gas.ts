import { getRPCService } from '../services/rpc.js';
import { getCacheService } from '../services/cache.js';
import { createChildLogger } from './logger.js';
import config from '../config/index.js';
import type { GasEstimate } from '../config/types.js';

const logger = createChildLogger('GasOptimizer');

export class GasOptimizer {
  private rpcService = getRPCService();
  private cacheService = getCacheService();
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly UPDATE_FREQUENCY = 5000; // 5 seconds
  private lastEstimate: GasEstimate | null = null;
  private gasPriceHistory: bigint[] = [];
  private readonly HISTORY_SIZE = 20;

  /**
   * Start automatic gas price updates
   */
  startAutoUpdate(): void {
    // Initial fetch
    this.updateGasEstimate();

    // Periodic updates
    this.updateInterval = setInterval(() => {
      this.updateGasEstimate();
    }, this.UPDATE_FREQUENCY);

    logger.info('Gas optimizer started');
  }

  /**
   * Stop automatic gas price updates
   */
  stopAutoUpdate(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    logger.info('Gas optimizer stopped');
  }

  /**
   * Update gas estimate from network
   */
  private async updateGasEstimate(): Promise<void> {
    try {
      const estimate = await this.rpcService.getOptimizedGasParams();
      
      // Track history for analysis
      this.gasPriceHistory.push(estimate.gasPrice);
      if (this.gasPriceHistory.length > this.HISTORY_SIZE) {
        this.gasPriceHistory.shift();
      }

      // Cache the estimate
      await this.cacheService.setGasEstimate(estimate);
      this.lastEstimate = estimate;

      logger.debug({
        gasPrice: this.formatGwei(estimate.gasPrice),
        maxFee: this.formatGwei(estimate.maxFeePerGas),
        priorityFee: this.formatGwei(estimate.maxPriorityFeePerGas),
      }, 'Gas estimate updated');

    } catch (error) {
      logger.error({ error }, 'Failed to update gas estimate');
    }
  }

  /**
   * Get current gas estimate
   */
  async getGasEstimate(): Promise<GasEstimate> {
    // Try cache first
    const cached = await this.cacheService.getGasEstimate();
    if (cached) {
      return cached;
    }

    // Use last known estimate
    if (this.lastEstimate) {
      return this.lastEstimate;
    }

    // Fetch fresh
    return this.rpcService.getOptimizedGasParams();
  }

  /**
   * Get aggressive gas estimate for time-sensitive transactions
   */
  async getAggressiveGasEstimate(): Promise<GasEstimate> {
    const base = await this.getGasEstimate();
    
    // Increase by 50% for aggressive execution
    const multiplier = 150n;
    const maxGasPrice = BigInt(config.trading.maxGasPriceGwei) * 10n ** 9n;

    let aggressiveGasPrice = (base.gasPrice * multiplier) / 100n;
    let aggressiveMaxFee = (base.maxFeePerGas * multiplier) / 100n;
    const aggressivePriorityFee = (base.maxPriorityFeePerGas * multiplier) / 100n;

    // Cap at maximum
    if (aggressiveGasPrice > maxGasPrice) {
      aggressiveGasPrice = maxGasPrice;
    }
    if (aggressiveMaxFee > maxGasPrice) {
      aggressiveMaxFee = maxGasPrice;
    }

    return {
      gasPrice: aggressiveGasPrice,
      maxFeePerGas: aggressiveMaxFee,
      maxPriorityFeePerGas: aggressivePriorityFee,
      estimatedGas: base.estimatedGas,
    };
  }

  /**
   * Calculate total gas cost in native token
   */
  calculateGasCost(gasEstimate: GasEstimate): bigint {
    return gasEstimate.gasPrice * gasEstimate.estimatedGas;
  }

  /**
   * Check if gas price is acceptable
   */
  isGasPriceAcceptable(estimate: GasEstimate): boolean {
    const maxGasPrice = BigInt(config.trading.maxGasPriceGwei) * 10n ** 9n;
    return estimate.gasPrice <= maxGasPrice;
  }

  /**
   * Get gas price trend
   */
  getGasTrend(): 'rising' | 'falling' | 'stable' {
    if (this.gasPriceHistory.length < 5) {
      return 'stable';
    }

    const recent = this.gasPriceHistory.slice(-5);
    const older = this.gasPriceHistory.slice(-10, -5);

    if (older.length === 0) {
      return 'stable';
    }

    const recentAvg = recent.reduce((a, b) => a + b, 0n) / BigInt(recent.length);
    const olderAvg = older.reduce((a, b) => a + b, 0n) / BigInt(older.length);

    const changePercent = Number((recentAvg - olderAvg) * 100n / olderAvg);

    if (changePercent > 10) {
      return 'rising';
    }
    if (changePercent < -10) {
      return 'falling';
    }
    return 'stable';
  }

  /**
   * Format gas price to Gwei string
   */
  formatGwei(wei: bigint): string {
    const gwei = Number(wei) / 1e9;
    return `${gwei.toFixed(2)} Gwei`;
  }

  /**
   * Get statistics
   */
  getStats(): {
    currentGasPrice: string;
    trend: string;
    historySize: number;
  } {
    return {
      currentGasPrice: this.lastEstimate ? this.formatGwei(this.lastEstimate.gasPrice) : 'unknown',
      trend: this.getGasTrend(),
      historySize: this.gasPriceHistory.length,
    };
  }
}

// Singleton instance
let gasOptimizerInstance: GasOptimizer | null = null;

export function getGasOptimizer(): GasOptimizer {
  if (!gasOptimizerInstance) {
    gasOptimizerInstance = new GasOptimizer();
  }
  return gasOptimizerInstance;
}

export default GasOptimizer;
