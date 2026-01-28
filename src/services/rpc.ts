import { ethers, JsonRpcProvider, FeeData } from 'ethers';
import config from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import type { GasEstimate } from '../config/types.js';
import { RETRY_CONFIG } from '../config/constants.js';

const logger = createChildLogger('RPCService');

interface RPCProvider {
  name: string;
  provider: JsonRpcProvider;
  priority: number;
  healthy: boolean;
  lastError?: Error;
  lastLatency: number;
  errorCount: number;
  lastHealthCheck: number;
}

export class RPCService {
  private providers: RPCProvider[] = [];
  private currentProviderIndex = 0;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly HEALTH_CHECK_INTERVAL = 10000; // 10 seconds
  private readonly MAX_ERROR_COUNT = 3;
  private readonly LATENCY_THRESHOLD = 2000; // 2 seconds

  constructor() {
    this.initializeProviders();
  }

  /**
   * Initialize RPC providers with failover support
   */
  private initializeProviders(): void {
    // Primary: Infura (if configured)
    if (config.rpc.infura.url && config.rpc.infura.projectId) {
      const infuraUrl = `${config.rpc.infura.url}${config.rpc.infura.projectId}`;
      this.providers.push({
        name: 'Infura',
        provider: new JsonRpcProvider(infuraUrl, 137, {
          staticNetwork: true,
          batchMaxCount: 10,
        }),
        priority: 1,
        healthy: true,
        lastLatency: 0,
        errorCount: 0,
        lastHealthCheck: Date.now(),
      });
      logger.info('Infura provider initialized');
    }

    // Secondary: Polygon Public RPC (always available as fallback)
    if (config.rpc.polygonPublic?.url) {
      this.providers.push({
        name: 'Polygon Public',
        provider: new JsonRpcProvider(config.rpc.polygonPublic.url, 137, {
          staticNetwork: true,
          batchMaxCount: 10,
        }),
        priority: 2,
        healthy: true,
        lastLatency: 0,
        errorCount: 0,
        lastHealthCheck: Date.now(),
      });
      logger.info('Polygon Public RPC provider initialized');
    }

    // Tertiary: Alchemy (if configured)
    if (config.rpc.alchemy?.apiKey) {
      const alchemyUrl = `${config.rpc.alchemy.url}${config.rpc.alchemy.apiKey}`;
      this.providers.push({
        name: 'Alchemy',
        provider: new JsonRpcProvider(alchemyUrl, 137, {
          staticNetwork: true,
          batchMaxCount: 10,
        }),
        priority: 3,
        healthy: true,
        lastLatency: 0,
        errorCount: 0,
        lastHealthCheck: Date.now(),
      });
      logger.info('Alchemy provider initialized');
    }

    // Legacy: QuickNode (if configured)
    if (config.rpc.quicknode.url) {
      this.providers.push({
        name: 'QuickNode',
        provider: new JsonRpcProvider(config.rpc.quicknode.url, 137, {
          staticNetwork: true,
          batchMaxCount: 10,
        }),
        priority: 4,
        healthy: true,
        lastLatency: 0,
        errorCount: 0,
        lastHealthCheck: Date.now(),
      });
      logger.info('QuickNode provider initialized');
    }

    if (this.providers.length === 0) {
      throw new Error('No RPC providers configured');
    }

    // Sort by priority
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Start health check monitoring
   */
  startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      await this.checkProviderHealth();
    }, this.HEALTH_CHECK_INTERVAL);

    // Initial health check
    this.checkProviderHealth();
  }

  /**
   * Stop health check monitoring
   */
  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Check health of all providers
   */
  private async checkProviderHealth(): Promise<void> {
    const healthChecks = this.providers.map(async (rpcProvider) => {
      const startTime = Date.now();
      try {
        await Promise.race([
          rpcProvider.provider.getBlockNumber(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Health check timeout')), 5000)
          ),
        ]);
        
        rpcProvider.lastLatency = Date.now() - startTime;
        rpcProvider.lastHealthCheck = Date.now();
        
        // Reset error count on success
        if (rpcProvider.errorCount > 0) {
          rpcProvider.errorCount = Math.max(0, rpcProvider.errorCount - 1);
        }
        
        // Mark as healthy if latency is acceptable
        rpcProvider.healthy = rpcProvider.lastLatency < this.LATENCY_THRESHOLD;
        
        logger.debug({
          provider: rpcProvider.name,
          latency: rpcProvider.lastLatency,
          healthy: rpcProvider.healthy,
        }, 'Health check completed');
        
      } catch (error) {
        rpcProvider.lastLatency = Date.now() - startTime;
        rpcProvider.lastError = error as Error;
        rpcProvider.errorCount++;
        rpcProvider.healthy = rpcProvider.errorCount < this.MAX_ERROR_COUNT;
        
        logger.warn({
          provider: rpcProvider.name,
          error: (error as Error).message,
          errorCount: rpcProvider.errorCount,
          healthy: rpcProvider.healthy,
        }, 'Health check failed');
      }
    });

    await Promise.allSettled(healthChecks);

    // Update current provider if needed
    this.selectBestProvider();
  }

  /**
   * Select the best available provider
   */
  private selectBestProvider(): void {
    const healthyProviders = this.providers
      .filter((p) => p.healthy)
      .sort((a, b) => {
        // First by priority, then by latency
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        return a.lastLatency - b.lastLatency;
      });

    if (healthyProviders.length > 0) {
      const newIndex = this.providers.indexOf(healthyProviders[0]);
      if (newIndex !== this.currentProviderIndex) {
        logger.info({
          from: this.providers[this.currentProviderIndex]?.name,
          to: healthyProviders[0].name,
        }, 'Switching RPC provider');
        this.currentProviderIndex = newIndex;
      }
    } else {
      logger.error('No healthy RPC providers available!');
    }
  }

  /**
   * Get the current active provider
   */
  getProvider(): JsonRpcProvider {
    return this.providers[this.currentProviderIndex].provider;
  }

  /**
   * Execute an RPC call with automatic failover
   */
  async executeWithFailover<T>(
    operation: (provider: JsonRpcProvider) => Promise<T>,
    operationName: string
  ): Promise<T> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < RETRY_CONFIG.MAX_RETRIES; attempt++) {
      // Try each provider
      for (let i = 0; i < this.providers.length; i++) {
        const providerIndex = (this.currentProviderIndex + i) % this.providers.length;
        const rpcProvider = this.providers[providerIndex];

        if (!rpcProvider.healthy && i > 0) {
          continue; // Skip unhealthy providers except current
        }

        try {
          const result = await Promise.race([
            operation(rpcProvider.provider),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('RPC timeout')), config.rpc.timeout)
            ),
          ]);

          const latency = Date.now() - startTime;
          logger.debug({
            operation: operationName,
            provider: rpcProvider.name,
            latency,
            attempt: attempt + 1,
          }, 'RPC call successful');

          return result;
        } catch (error) {
          lastError = error as Error;
          rpcProvider.errorCount++;
          
          logger.warn({
            operation: operationName,
            provider: rpcProvider.name,
            error: lastError.message,
            attempt: attempt + 1,
          }, 'RPC call failed');

          // Mark provider as unhealthy if too many errors
          if (rpcProvider.errorCount >= this.MAX_ERROR_COUNT) {
            rpcProvider.healthy = false;
            this.selectBestProvider();
          }
        }
      }

      // Exponential backoff before retry
      if (attempt < RETRY_CONFIG.MAX_RETRIES - 1) {
        const delay = Math.min(
          RETRY_CONFIG.BASE_DELAY_MS * Math.pow(RETRY_CONFIG.BACKOFF_MULTIPLIER, attempt),
          RETRY_CONFIG.MAX_DELAY_MS
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error(`${operationName} failed after all retries`);
  }

  /**
   * Get optimized gas parameters for fast execution
   */
  async getOptimizedGasParams(): Promise<GasEstimate> {
    return this.executeWithFailover(async (provider) => {
      const feeData: FeeData = await provider.getFeeData();

      if (!feeData.gasPrice) {
        throw new Error('Failed to get gas price');
      }

      // Apply multiplier for faster execution
      const multiplier = BigInt(Math.floor(config.trading.gasPriceMultiplier * 100));
      const optimizedGasPrice = (feeData.gasPrice * multiplier) / 100n;

      // Cap at maximum gas price
      const maxGasPrice = BigInt(config.trading.maxGasPriceGwei) * 10n ** 9n;
      const finalGasPrice = optimizedGasPrice > maxGasPrice ? maxGasPrice : optimizedGasPrice;

      // EIP-1559 parameters
      const maxFeePerGas = feeData.maxFeePerGas
        ? (feeData.maxFeePerGas * multiplier) / 100n
        : finalGasPrice;
      const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
        ? (feeData.maxPriorityFeePerGas * multiplier) / 100n
        : 30n * 10n ** 9n; // 30 Gwei default priority fee

      return {
        gasPrice: finalGasPrice,
        maxFeePerGas: maxFeePerGas > maxGasPrice ? maxGasPrice : maxFeePerGas,
        maxPriorityFeePerGas,
        estimatedGas: 500000n, // Conservative estimate for Polymarket orders
      };
    }, 'getOptimizedGasParams');
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    return this.executeWithFailover(
      (provider) => provider.getBlockNumber(),
      'getBlockNumber'
    );
  }

  /**
   * Get account nonce
   */
  async getNonce(address: string): Promise<number> {
    return this.executeWithFailover(
      (provider) => provider.getTransactionCount(address, 'pending'),
      'getNonce'
    );
  }

  /**
   * Get account balance
   */
  async getBalance(address: string): Promise<bigint> {
    return this.executeWithFailover(
      (provider) => provider.getBalance(address),
      'getBalance'
    );
  }

  /**
   * Send signed transaction
   */
  async sendTransaction(signedTx: string): Promise<ethers.TransactionResponse> {
    return this.executeWithFailover(
      (provider) => provider.broadcastTransaction(signedTx),
      'sendTransaction'
    );
  }

  /**
   * Wait for transaction confirmation
   */
  async waitForTransaction(
    txHash: string,
    confirmations: number = 1
  ): Promise<ethers.TransactionReceipt | null> {
    return this.executeWithFailover(async (provider) => {
      return provider.waitForTransaction(txHash, confirmations, 30000);
    }, 'waitForTransaction');
  }

  /**
   * Get provider status
   */
  getStatus(): { name: string; healthy: boolean; latency: number }[] {
    return this.providers.map((p) => ({
      name: p.name,
      healthy: p.healthy,
      latency: p.lastLatency,
    }));
  }

  /**
   * Get current provider name
   */
  getCurrentProviderName(): string {
    return this.providers[this.currentProviderIndex]?.name || 'unknown';
  }
}

// Singleton instance
let rpcServiceInstance: RPCService | null = null;

export function getRPCService(): RPCService {
  if (!rpcServiceInstance) {
    rpcServiceInstance = new RPCService();
  }
  return rpcServiceInstance;
}

export default RPCService;
