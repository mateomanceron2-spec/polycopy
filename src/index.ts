import config from './config/index.js';
import { createChildLogger } from './utils/logger.js';
import { getRPCService } from './services/rpc.js';
import { getCacheService } from './services/cache.js';
import { getDatabaseService } from './services/database.js';
import { getTradeMonitor } from './monitors/tradeMonitor.js';
import { getOrderExecutor } from './executors/orderExecutor.js';
import { getRPCProviderManager } from './services/rpcProviderManager.js';
import { getHealthMonitor } from './services/healthMonitor.js';
import { getAlertService } from './services/alertService.js';
import { getPositionSizing } from './services/positionSizing.js';
import { getTradeValidator } from './services/tradeValidator.js';
import { getCircuitBreaker } from './services/circuitBreaker.js';
import { getSafetyLimits } from './services/safetyLimits.js';
import { getControlFeatures } from './services/controlFeatures.js';
import { getDryRunService } from './services/dryRunService.js';
import { getDashboard } from './services/dashboard.js';
import type { CopyTradeSignal, HealthStatus, PerformanceMetrics } from './config/types.js';

const logger = createChildLogger('Main');

class PolymarketCopyTradeBot {
  private rpcService = getRPCService();
  private rpcProviderManager = getRPCProviderManager();
  private cacheService = getCacheService();
  private databaseService = getDatabaseService();
  private tradeMonitor = getTradeMonitor();
  private orderExecutor = getOrderExecutor();
  private healthMonitor = getHealthMonitor();
  private alertService = getAlertService();
  private positionSizing = getPositionSizing();
  private tradeValidator = getTradeValidator();
  private circuitBreaker = getCircuitBreaker();
  private safetyLimits = getSafetyLimits();
  private controlFeatures = getControlFeatures();
  private dryRunService = getDryRunService();
  private dashboard = getDashboard();

  private isRunning = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;
  private walletBalanceInterval: NodeJS.Timeout | null = null;
  private dryRunSummaryInterval: NodeJS.Timeout | null = null;
  private startTime = 0;

  /**
   * Initialize and start the bot
   */
  async start(): Promise<void> {
    logger.info('Starting Polymarket Copy Trade Bot (Multi-RPC with Failover)...');
    this.startTime = Date.now();

    try {
      // Step 1: Connect to cache (Redis)
      logger.info('Connecting to cache...');
      await this.cacheService.connect();
      this.healthMonitor.registerComponent('Redis');
      this.healthMonitor.updateComponentStatus('Redis', 'healthy');

      // Step 2: Connect to database (MongoDB)
      logger.info('Connecting to database...');
      await this.databaseService.connect();
      this.healthMonitor.registerComponent('MongoDB');
      this.healthMonitor.updateComponentStatus('MongoDB', 'healthy');

      // Step 3: Preload contract ABIs into cache
      logger.info('Preloading contract ABIs...');
      this.preloadContractABIs();

      // Step 4: Initialize multi-RPC provider with failover
      logger.info('Initializing RPC provider manager with failover...');
      this.healthMonitor.registerComponent('Infura');
      this.healthMonitor.registerComponent('PolygonPublic');
      this.healthMonitor.registerComponent('Alchemy');
      await this.setupRPCProviderManager();

      // Step 5: Initialize RPC service (legacy, for backward compatibility)
      logger.info('Initializing RPC service...');
      this.rpcService.startHealthCheck();

      // Step 6: Initialize order executor
      logger.info('Initializing order executor...');
      await this.orderExecutor.initialize();

      // Step 6.5: Start dashboard
      this.dashboard.start(this.orderExecutor.getWalletAddress());
      this.dashboard.updateHealth({ 
        redis: this.cacheService.isConnected() ? 'Connected' : 'In-Memory',
        mongo: this.databaseService.isConnectedToDb() ? 'Connected' : 'In-Memory'
      });

      // Step 7: Setup trade signal handler
      this.setupSignalHandler();
      
      // Step 7.5: Setup new service event handlers
      this.setupServiceEventHandlers();

      // Step 8: Start trade monitor (connects to blockchain WebSocket)
      logger.info('Starting blockchain trade monitor...');
      this.healthMonitor.registerComponent('BlockchainMonitor');
      await this.tradeMonitor.start();
      this.healthMonitor.updateComponentStatus('BlockchainMonitor', 'healthy');

      // Step 9: Start health monitoring
      this.healthMonitor.start();
      this.startHealthMonitoring();
      this.startMetricsCollection();
      this.startWalletBalanceUpdater();
      
      // Step 10: Start dry-run summary interval (if dry-run mode)
      if (this.controlFeatures.isDryRun()) {
        this.startDryRunSummaryInterval();
      }

      this.isRunning = true;

      // Log startup summary
      this.logStartupSummary();

      // Setup graceful shutdown via control features
      this.controlFeatures.onShutdown(async () => {
        await this.stop();
      });
      this.setupShutdownHandlers();
      
      // Send startup alert
      await this.alertService.alertSystemStart();

    } catch (error) {
      logger.error({ error }, 'Failed to start bot');
      await this.alertService.sendAlert(
        'connection_failure',
        'critical',
        `Bot startup failed: ${(error as Error).message}`
      );
      await this.stop();
      throw error;
    }
  }

  /**
   * Preload contract ABIs for local caching
   */
  private preloadContractABIs(): void {
    // These ABIs are cached locally at startup - never fetched from network
    const abis = new Map<string, object>();
    
    // CTF Exchange ABI (minimal for events)
    abis.set('0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', {
      name: 'CTFExchange',
      events: ['OrderFilled'],
    });
    
    // Neg Risk CTF Exchange ABI
    abis.set('0xC5d563A36AE78145C45a50134d48A1215220f80a', {
      name: 'NegRiskCTFExchange',
      events: ['OrderFilled'],
    });
    
    // USDC ABI (for balance checks)
    abis.set('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', {
      name: 'USDC',
      decimals: 6,
    });

    this.cacheService.preloadContractABIs(abis);
  }

  /**
   * Setup RPC provider manager with failover handlers
   */
  private async setupRPCProviderManager(): Promise<void> {
    // Setup event handlers for failover notifications
    this.rpcProviderManager.on('connected', (provider: string) => {
      logger.info({ provider }, 'RPC provider connected');
      this.healthMonitor.updateComponentStatus(provider, 'healthy');
      this.dashboard.updateRpcStatus('connected', provider);
    });

    this.rpcProviderManager.on('disconnected', (provider: string, reason: string) => {
      logger.warn({ provider, reason }, 'RPC provider disconnected');
      this.healthMonitor.updateComponentStatus(provider, 'down');
      this.dashboard.updateRpcStatus('disconnected', provider);
    });

    this.rpcProviderManager.on('failover', (from: string, to: string) => {
      logger.warn({ from, to }, 'RPC failover triggered');
      this.alertService.sendAlert(
        'degraded_mode',
        'warning',
        `RPC failover: ${from} → ${to}`
      );
      this.dashboard.updateRpcStatus('failover', to);
    });

    this.rpcProviderManager.on('degraded', (message: string) => {
      logger.warn({ message }, 'Running in degraded mode');
      this.alertService.alertDegradedMode(message);
    });

    this.rpcProviderManager.on('restored', (provider: string) => {
      logger.info({ provider }, 'RPC connection restored');
      this.alertService.alertConnectionRestored(provider);
    });

    this.rpcProviderManager.on('alert', (message: string, severity: 'warning' | 'critical') => {
      this.alertService.sendAlert('health_check', severity, message);
    });

    // Connect to RPC providers
    await this.rpcProviderManager.connect();
  }

  /**
   * Setup trade signal handler
   */
  private setupSignalHandler(): void {
    // Also listen for raw blockchain events for dry-run processing
    this.tradeMonitor.on('rawEvent', async (event: import('./config/types.js').OrderFilledEvent) => {
      // This is used by dry-run to get the original event details
      if (this.controlFeatures.isDryRun()) {
        // Store temporarily for signal handler to access
        (this as unknown as { _lastRawEvent: import('./config/types.js').OrderFilledEvent })._lastRawEvent = event;
      }
    });

    this.tradeMonitor.on('signal', async (signal: CopyTradeSignal) => {
      // Update dashboard - trade detected
      this.dashboard.recordTradeDetected();
      
      logger.info({
        signalId: signal.id,
        market: signal.market,
        side: signal.side,
        size: signal.calculatedSize,
      }, 'Processing trade signal');

      try {
        // Check 1: Control features (kill switch, pause) - but not dry-run here
        const canTrade = await this.controlFeatures.canTrade();
        if (!canTrade.allowed && canTrade.reason !== 'Dry-run mode active') {
          logger.warn({ reason: canTrade.reason, signalId: signal.id }, 'Trade blocked by control features');
          return;
        }
        
        // Check 2: DRY-RUN MODE - Full processing with detailed logging
        if (this.controlFeatures.isDryRun()) {
          // Create a synthetic OrderFilledEvent from the signal for dry-run processing
          const syntheticEvent: import('./config/types.js').OrderFilledEvent = {
            orderHash: signal.id,
            maker: signal.targetTrade?.maker_address || config.wallet.targetAddresses[0] || '',
            taker: this.orderExecutor.getWalletAddress(),
            makerAssetId: signal.assetId,
            takerAssetId: signal.assetId,
            makerAmountFilled: (parseFloat(signal.calculatedSize) * 1e6).toString(),
            takerAmountFilled: (parseFloat(signal.calculatedSize) * 1e6).toString(),
            price: signal.maxPrice,
            fee: '0',
            side: signal.side as 'BUY' | 'SELL',
            tokenId: signal.assetId,
            transactionHash: signal.targetTrade?.transaction_hash || `0x${Date.now().toString(16)}`,
            blockNumber: 0, // Block number not available from Trade type
            logIndex: 0, // Log index not available from Trade type
            timestamp: signal.detectedAt,
            usdcAmount: (parseFloat(signal.calculatedSize) * parseFloat(signal.maxPrice) * 1e6).toString(),
            tokenAmount: (parseFloat(signal.calculatedSize) * 1e6).toString(),
          };
          
          // Process through dry-run service with full validation and logging
          await this.dryRunService.processDryRunSignal(
            signal,
            syntheticEvent,
            this.orderExecutor.getWalletAddress()
          );
          
          // Update dashboard with simulated trade
          this.dashboard.recordTradeExecuted(signal, true);
          
          // Update P&L in dashboard
          const dryRunStats = this.dryRunService.getStats();
          this.dashboard.updatePnL(
            dryRunStats.totalPnL,
            dryRunStats.unrealizedPnL,
            dryRunStats.totalVolume
          );
          return;
        }
        
        // Check 3: Circuit breaker
        if (!this.circuitBreaker.isAllowed()) {
          const status = this.circuitBreaker.getStatus();
          logger.warn({ 
            state: status.state, 
            willCloseAt: status.willCloseAt,
            signalId: signal.id,
          }, 'Trade blocked by circuit breaker');
          return;
        }
        
        // Check 4: Safety limits
        const safetyStatus = await this.safetyLimits.isTradingAllowed();
        if (!safetyStatus.tradingAllowed) {
          logger.warn({ reason: safetyStatus.reason, signalId: signal.id }, 'Trade blocked by safety limits');
          if (safetyStatus.warningsTriggered.includes('DAILY_LOSS_LIMIT')) {
            await this.alertService.alertDailyLossLimit(
              -safetyStatus.dailyStats.realizedPnL,
              config.trading.dailyLossLimit
            );
          }
          return;
        }

        // Execute the trade
        const result = await this.orderExecutor.executeSignal(signal);

        // Persist to database
        await this.databaseService.saveTrade(result);

        if (result.status === 'EXECUTED') {
          // Record success
          this.circuitBreaker.recordSuccess();
          
          // Update trade validator state
          this.tradeValidator.updateMarketLastTrade(signal.assetId);
          await this.tradeValidator.markOrderProcessed(signal.id);
          
          // Record trade in safety limits
          await this.safetyLimits.recordTrade({
            id: signal.id,
            timestamp: Date.now(),
            tokenId: signal.assetId,
            side: signal.side as 'BUY' | 'SELL',
            size: parseFloat(signal.calculatedSize),
            price: parseFloat(signal.maxPrice),
            fee: 0,
            status: 'FILLED',
          });
          
          logger.info({
            signalId: result.id,
            latency: result.executionLatency,
          }, 'Trade executed successfully');
          
          await this.alertService.alertTradeSuccess(
            result.id,
            signal.calculatedSize,
            signal.side,
            signal.assetId
          );
          
          // Update dashboard
          this.dashboard.recordTradeExecuted(result, false);
        } else {
          // Record failure
          this.circuitBreaker.recordFailure(result.error || 'Unknown error', { signalId: signal.id });
          
          logger.warn({
            signalId: result.id,
            error: result.error,
          }, 'Trade execution failed');
          await this.alertService.alertTradeFailure(result.id, result.error || 'Unknown error');
          
          // Update dashboard
          this.dashboard.recordTradeExecuted(result, false);
          this.dashboard.recordError(result.error || 'Unknown error');
        }
      } catch (error) {
        // Record failure in circuit breaker
        this.circuitBreaker.recordFailure((error as Error).message, { signalId: signal.id });
        
        logger.error({ error, signalId: signal.id }, 'Error processing signal');
        await this.databaseService.logError('signal_processing', error as Error, { signal });
        await this.alertService.alertTradeFailure(signal.id, (error as Error).message);
      }
    });

    this.tradeMonitor.on('error', async (error: Error) => {
      logger.error({ error: error.message }, 'Trade monitor error');
      await this.databaseService.logError('trade_monitor', error);
      this.healthMonitor.updateComponentStatus('BlockchainMonitor', 'degraded');
    });

    // Record events for health monitoring
    this.tradeMonitor.on('event', (latencyMs: number, isTarget: boolean) => {
      this.healthMonitor.recordEvent(latencyMs, isTarget);
    });
  }

  /**
   * Setup event handlers for new services
   */
  private setupServiceEventHandlers(): void {
    // Circuit breaker events
    this.circuitBreaker.on('opened', async (data: { consecutiveFailures: number; pauseMinutes: number }) => {
      logger.error({
        failures: data.consecutiveFailures,
        pauseMinutes: data.pauseMinutes,
      }, 'Circuit breaker OPENED');
      await this.alertService.alertCircuitBreaker('OPEN', data.consecutiveFailures);
    });

    this.circuitBreaker.on('closed', async () => {
      logger.info('Circuit breaker CLOSED');
      await this.alertService.alertCircuitBreaker('CLOSED', 0);
    });

    // Safety limits events
    this.safetyLimits.on('safetyStop', async (data: { reason: string }) => {
      logger.error({ reason: data.reason }, 'Safety stop triggered');
      await this.controlFeatures.activateKillSwitch(data.reason);
      await this.alertService.alertKillSwitch(data.reason);
    });

    this.safetyLimits.on('warning', async (data: { type: string; message: string }) => {
      logger.warn({ type: data.type, message: data.message }, 'Safety warning');
      if (data.type.includes('BALANCE')) {
        const stats = this.safetyLimits.getDailyStats();
        await this.alertService.alertBalanceWarning(stats.currentBalance, config.wallet.minBalance);
      }
    });

    // Control features events
    this.controlFeatures.on('killSwitch', async (data: { active: boolean; reason?: string }) => {
      if (data.active) {
        logger.error({ reason: data.reason }, 'Kill switch activated');
        await this.alertService.alertKillSwitch(data.reason || 'Manual activation');
      } else {
        logger.info('Kill switch deactivated');
      }
    });

    this.controlFeatures.on('paused', async (data: { reason?: string }) => {
      logger.warn({ reason: data.reason }, 'Trading paused');
    });

    this.controlFeatures.on('resumed', async () => {
      logger.info('Trading resumed');
    });

    this.controlFeatures.on('configReloaded', (data: { keys: string[] }) => {
      logger.info({ keys: data.keys }, 'Configuration reloaded');
    });
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      const health = await this.getHealthStatus();
      await this.cacheService.setHealthStatus(health);

      // Log warnings for unhealthy components
      if (health.blockchainMonitor !== 'connected') {
        logger.warn({ status: health.blockchainMonitor }, 'Blockchain monitor unhealthy');
      }
      if (health.primaryRpc !== 'healthy') {
        logger.warn({ status: health.primaryRpc }, 'Primary RPC unhealthy');
      }

      // Update RPC provider status in cache
      const rpcStatuses = this.rpcProviderManager.getProviderStatuses();
      await this.cacheService.setRPCProviderStatus({
        providers: rpcStatuses,
        activeProvider: this.rpcProviderManager.getActiveProviderName(),
        isPollingMode: this.rpcProviderManager.isInPollingMode(),
        metrics: this.rpcProviderManager.getMetrics(),
      });
    }, config.health.checkInterval);
  }

  /**
   * Start metrics collection
   */
  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(async () => {
      const metrics = this.getPerformanceMetrics();
      await this.databaseService.saveMetrics(metrics);

      // Get health report for detailed logging
      const healthReport = this.healthMonitor.getHealthReport();

      // Log periodic status
      logger.info({
        avgE2ELatency: metrics.endToEndLatency.length > 0
          ? (metrics.endToEndLatency.reduce((a, b) => a + b, 0) / metrics.endToEndLatency.length).toFixed(0)
          : 0,
        successRate: metrics.successRate.toFixed(2),
        totalCopied: metrics.totalTradesCopied,
        uptime: this.getUptimeString(),
        rpcProvider: this.rpcProviderManager.getActiveProviderName(),
        pollingMode: this.rpcProviderManager.isInPollingMode(),
        overallHealth: healthReport.overallStatus,
      }, 'Bot status');
    }, 60000); // Every minute
  }

  /**
   * Start wallet balance updater (background refresh every 30 seconds)
   */
  private startWalletBalanceUpdater(): void {
    const updateBalance = async () => {
      try {
        const walletAddress = this.orderExecutor.getWalletAddress();
        const provider = this.rpcProviderManager.getHttpProvider();
        
        // Get USDC balance (Polymarket uses USDC)
        const usdcContract = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const balanceData = await provider.call({
          to: usdcContract,
          data: `0x70a08231000000000000000000000000${walletAddress.slice(2)}`,
        });
        const usdcBalance = BigInt(balanceData).toString();

        // Get MATIC balance
        const maticBalance = await provider.getBalance(walletAddress);

        // Cache the balances
        await this.cacheService.setWalletBalance(walletAddress, {
          usdc: usdcBalance,
          matic: maticBalance.toString(),
        });

        // Update dashboard
        const usdcFormatted = (Number(usdcBalance) / 1e6).toFixed(2);
        const maticFormatted = (Number(maticBalance) / 1e18).toFixed(4);
        this.dashboard.updateBalances(usdcFormatted, maticFormatted);

        logger.debug({
          usdc: usdcFormatted,
          matic: maticFormatted,
        }, 'Wallet balance updated');
      } catch (error) {
        logger.error({ error }, 'Failed to update wallet balance');
      }
    };

    // Initial update
    updateBalance();

    // Update every 30 seconds
    this.walletBalanceInterval = setInterval(updateBalance, 30000);
  }

  /**
   * Start dry-run summary interval (hourly summaries)
   */
  private startDryRunSummaryInterval(): void {
    // Print summary every hour
    this.dryRunSummaryInterval = setInterval(() => {
      this.dryRunService.printSummary();
    }, 3600000); // 1 hour
    
    // Also print summary on process signals
    logger.info('Dry-run summary will be printed hourly and on shutdown');
  }

  /**
   * Get health status
   */
  async getHealthStatus(): Promise<HealthStatus> {
    const rpcProviderStatuses = this.rpcProviderManager.getProviderStatuses();
    
    const infuraStatus = rpcProviderStatuses.find(r => r.name === 'Infura');
    const polygonStatus = rpcProviderStatuses.find(r => r.name === 'Polygon Public');
    const blockchainStatus = this.tradeMonitor.getMetrics().blockchainStatus;

    return {
      websocket: 'disconnected', // Not using Polymarket WebSocket anymore
      blockchainMonitor: blockchainStatus as 'connected' | 'disconnected' | 'reconnecting',
      primaryRpc: infuraStatus?.httpHealthy || infuraStatus?.wsConnected ? 'healthy' : 'degraded',
      failoverRpc: polygonStatus?.httpHealthy ? 'healthy' : 'down',
      redis: this.cacheService.isConnected() ? 'connected' : 'disconnected',
      mongodb: this.databaseService.isConnectedToDb() ? 'connected' : 'disconnected',
      lastHealthCheck: Date.now(),
    };
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): PerformanceMetrics {
    const monitorMetrics = this.tradeMonitor.getMetrics();
    const executorMetrics = this.orderExecutor.getMetrics();

    return {
      tradeDetectionLatency: [monitorMetrics.avgDetectionLatency],
      orderExecutionLatency: [executorMetrics.avgExecutionLatency],
      endToEndLatency: executorMetrics.avgExecutionLatency > 0
        ? [monitorMetrics.avgDetectionLatency + executorMetrics.avgExecutionLatency]
        : [],
      successRate: executorMetrics.successRate,
      totalTradesCopied: executorMetrics.successCount,
      totalTradesFailed: executorMetrics.failCount,
      lastUpdate: Date.now(),
    };
  }

  /**
   * Log startup summary
   */
  private logStartupSummary(): void {
    const activeProvider = this.rpcProviderManager.getActiveProviderName();
    
    // Update dashboard with RPC info
    this.dashboard.updateRpcStatus('healthy', activeProvider || 'Polygon Public');
    
    // Just log that bot started - dashboard will show details
    logger.info('CopyTrade bot started successfully');
    logger.info(`Mode: ${this.controlFeatures.isDryRun() ? 'DRY-RUN' : 'LIVE'}`);
    logger.info(`Target wallets: ${config.wallet.targetAddresses.length}`);
    logger.info('Dashboard active - press Ctrl+C to stop');
  }

  /**
   * Get uptime string
   */
  private getUptimeString(): string {
    const uptimeMs = Date.now() - this.startTime;
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received');
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('uncaughtException', async (error) => {
      logger.error({ error }, 'Uncaught exception');
      await this.databaseService.logError('uncaught_exception', error);
      await this.stop();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
      logger.error({ reason }, 'Unhandled rejection');
      await this.databaseService.logError(
        'unhandled_rejection',
        new Error(String(reason))
      );
    });
  }

  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping bot...');
    
    // Stop dashboard and print final summary
    this.dashboard.stop();
    this.dashboard.printFinalSummary();
    
    // Print dry-run summary if in dry-run mode
    if (this.controlFeatures.isDryRun()) {
      this.dryRunService.printSummary();
    }
    
    // Send stop alert
    await this.alertService.alertSystemStop('Graceful shutdown');

    // Stop intervals
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    if (this.walletBalanceInterval) {
      clearInterval(this.walletBalanceInterval);
    }
    if (this.dryRunSummaryInterval) {
      clearInterval(this.dryRunSummaryInterval);
    }

    // Stop health monitor
    this.healthMonitor.stop();
    
    // Stop new services
    this.circuitBreaker.shutdown();
    await this.safetyLimits.shutdown();
    this.positionSizing.stopBackgroundUpdates();

    // Stop components
    await this.tradeMonitor.stop();
    this.rpcService.stopHealthCheck();
    this.orderExecutor.shutdown();

    // Disconnect RPC provider manager
    await this.rpcProviderManager.disconnect();

    // Disconnect services
    await this.cacheService.disconnect();
    await this.databaseService.disconnect();

    this.isRunning = false;
    logger.info('Bot stopped');
  }

  /**
   * Check if bot is running
   */
  isBotRunning(): boolean {
    return this.isRunning;
  }
}

// Main entry point
async function main(): Promise<void> {
  const bot = new PolymarketCopyTradeBot();

  try {
    await bot.start();
  } catch (error) {
    logger.error({ error }, 'Bot startup failed');
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

export { PolymarketCopyTradeBot };
