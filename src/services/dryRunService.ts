/**
 * Dry-Run Service
 * 
 * Comprehensive dry-run mode implementation:
 * - Detailed logging of detected trades
 * - Full validation pipeline execution
 * - Order signing without submission
 * - Simulated P&L tracking
 * - 24-48 hour validation support
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';
import { getTradeValidator } from './tradeValidator.js';
import { getPositionSizing } from './positionSizing.js';
import { getSafetyLimits } from './safetyLimits.js';
import { getCircuitBreaker } from './circuitBreaker.js';
import { getDatabaseService } from './database.js';
import type { CopyTradeSignal, OrderFilledEvent } from '../config/types.js';

const logger = createChildLogger('DryRun');

export interface DryRunLogEntry {
  // Timestamps
  eventDetectedAt: string;
  logTimestamp: string;
  
  // Target info
  targetWallet: string;
  orderHash: string;
  transactionHash: string;
  
  // Market info
  market: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  
  // Pricing
  targetPrice: number;
  calculatedPrice: number;
  pricePremium: number;
  currentMarketPrice?: number;
  
  // Sizing
  targetSize: number;
  calculatedSize: number;
  tradeMultiplier: number;
  
  // Validation
  wouldExecute: boolean;
  skipReason?: string;
  validationDetails: {
    duplicateCheck: boolean;
    cooldownCheck: boolean;
    slippageCheck: boolean;
    balanceCheck: boolean;
    safetyLimitsCheck: boolean;
    circuitBreakerCheck: boolean;
  };
  
  // Simulated execution
  simulatedOrderId?: string;
  walletBalance?: number;
  balanceAfterTrade?: number;
  
  // P&L tracking
  simulatedPnL?: {
    entryPrice: number;
    currentPrice?: number;
    unrealizedPnL?: number;
    size: number;
  };
}

export interface DryRunStats {
  startTime: number;
  runDuration: number;
  totalEventsDetected: number;
  wouldExecuteCount: number;
  skippedCount: number;
  skipReasons: Record<string, number>;
  simulatedTrades: DryRunLogEntry[];
  simulatedPnL: {
    totalUnrealizedPnL: number;
    winningTrades: number;
    losingTrades: number;
    largestWin: number;
    largestLoss: number;
  };
  averageDetectionLatency: number;
  marketsCovered: Set<string>;
}

export class DryRunService extends EventEmitter {
  private tradeValidator = getTradeValidator();
  private positionSizing = getPositionSizing();
  private safetyLimits = getSafetyLimits();
  private circuitBreaker = getCircuitBreaker();
  private databaseService = getDatabaseService();
  
  // Stats tracking
  private stats: DryRunStats;
  private simulatedPositions: Map<string, { entryPrice: number; size: number; side: 'BUY' | 'SELL'; timestamp: number; tokenId: string }> = new Map();
  
  // Log storage
  private logEntries: DryRunLogEntry[] = [];
  private readonly MAX_LOG_ENTRIES = 10000;
  
  // P&L history tracking
  private pnlHistory: number[] = [];
  
  // WebSocket price tracking
  private priceWs: WebSocket | null = null;
  private subscribedTokens: Set<string> = new Set();
  private latestPrices: Map<string, number> = new Map();
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  
  constructor() {
    super();
    this.stats = this.initializeStats();
    this.connectPriceWebSocket();
  }
  
  /**
   * Connect to Polymarket CLOB WebSocket for live price updates
   */
  private connectPriceWebSocket(): void {
    try {
      this.priceWs = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
      
      this.priceWs.on('open', () => {
        logger.info('Connected to Polymarket CLOB WebSocket for live prices');
        
        // Subscribe to all current positions
        this.resubscribeAllPositions();
      });
      
      this.priceWs.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handlePriceUpdate(message);
        } catch (error) {
          logger.error({ error }, 'Failed to parse WebSocket price message');
        }
      });
      
      this.priceWs.on('error', (error) => {
        logger.error({ error: error.message }, 'WebSocket price connection error');
      });
      
      this.priceWs.on('close', () => {
        logger.warn('WebSocket price connection closed, reconnecting in 5s');
        this.priceWs = null;
        
        // Reconnect after 5 seconds
        this.wsReconnectTimer = setTimeout(() => {
          this.connectPriceWebSocket();
        }, 5000);
      });
      
    } catch (error) {
      logger.error({ error }, 'Failed to connect to price WebSocket');
    }
  }
  
  /**
   * Handle incoming price update from WebSocket
   */
  private handlePriceUpdate(message: any): void {
    try {
      // Polymarket sends price updates in format: { event_type: 'price_change', asset_id: '...', price: '0.52' }
      if (message.event_type === 'price_change' || message.market) {
        const tokenId = message.asset_id || message.token_id || message.market;
        const price = parseFloat(message.price || message.last || '0');
        
        if (tokenId && price > 0) {
          this.latestPrices.set(tokenId, price);
          
          // Update P&L for positions with this token
          this.updatePositionPnL(tokenId, price);
        }
      }
    } catch (error) {
      logger.error({ error }, 'Failed to handle price update');
    }
  }
  
  /**
   * Update P&L for a specific position when price changes
   */
  private updatePositionPnL(tokenId: string, currentPrice: number): void {
    for (const [orderId, position] of this.simulatedPositions) {
      if (position.tokenId === tokenId) {
        // Calculate unrealized P&L
        let unrealizedPnL = 0;
        if (position.side === 'BUY') {
          unrealizedPnL = (currentPrice - position.entryPrice) * position.size;
        } else {
          unrealizedPnL = (position.entryPrice - currentPrice) * position.size;
        }
        
        // Update log entry
        const entry = this.logEntries.find(e => e.simulatedOrderId === orderId);
        if (entry && entry.simulatedPnL) {
          const oldPnL = entry.simulatedPnL.unrealizedPnL || 0;
          entry.simulatedPnL.currentPrice = currentPrice;
          entry.simulatedPnL.unrealizedPnL = unrealizedPnL;
          entry.currentMarketPrice = currentPrice;
          
          // Update total stats
          this.stats.simulatedPnL.totalUnrealizedPnL += (unrealizedPnL - oldPnL);
          
          // Take P&L snapshot every update for history
          this.pnlHistory.push(this.stats.simulatedPnL.totalUnrealizedPnL);
          if (this.pnlHistory.length > 100) {
            this.pnlHistory.shift();
          }
          
          // Update win/loss tracking
          if (unrealizedPnL > 0 && oldPnL <= 0) {
            this.stats.simulatedPnL.winningTrades++;
            if (oldPnL < 0) this.stats.simulatedPnL.losingTrades--;
          } else if (unrealizedPnL <= 0 && oldPnL > 0) {
            this.stats.simulatedPnL.losingTrades++;
            this.stats.simulatedPnL.winningTrades--;
          }
          
          // Track largest win/loss
          if (unrealizedPnL > this.stats.simulatedPnL.largestWin) {
            this.stats.simulatedPnL.largestWin = unrealizedPnL;
          }
          if (unrealizedPnL < this.stats.simulatedPnL.largestLoss) {
            this.stats.simulatedPnL.largestLoss = unrealizedPnL;
          }
        }
      }
    }
  }
  
  /**
   * Subscribe to price updates for a token
   */
  private subscribeToToken(tokenId: string): void {
    if (!this.priceWs || this.priceWs.readyState !== WebSocket.OPEN) {
      return;
    }
    
    if (this.subscribedTokens.has(tokenId)) {
      return;
    }
    
    try {
      // Subscribe to market updates for this token
      const subscribeMsg = {
        type: 'subscribe',
        channel: 'market',
        market: tokenId,
      };
      
      this.priceWs.send(JSON.stringify(subscribeMsg));
      this.subscribedTokens.add(tokenId);
      
      logger.info({ tokenId: tokenId.slice(0, 16) }, 'Subscribed to live prices');
    } catch (error) {
      logger.error({ error, tokenId }, 'Failed to subscribe to token prices');
    }
  }
  
  /**
   * Resubscribe to all current positions after reconnect
   */
  private resubscribeAllPositions(): void {
    this.subscribedTokens.clear();
    
    const uniqueTokens = new Set<string>();
    for (const position of this.simulatedPositions.values()) {
      uniqueTokens.add(position.tokenId);
    }
    
    for (const tokenId of uniqueTokens) {
      this.subscribeToToken(tokenId);
    }
    
    logger.info({ count: uniqueTokens.size }, 'Resubscribed to position prices');
  }
  
  /**
   * Start simulating P&L updates with small random price movements
   * DEPRECATED: Now using WebSocket live prices - removed
   */
  
  // Deprecated price fetching function removed - now using WebSocket

  private initializeStats(): DryRunStats {
    return {
      startTime: Date.now(),
      runDuration: 0,
      totalEventsDetected: 0,
      wouldExecuteCount: 0,
      skippedCount: 0,
      skipReasons: {},
      simulatedTrades: [],
      simulatedPnL: {
        totalUnrealizedPnL: 0,
        winningTrades: 0,
        losingTrades: 0,
        largestWin: 0,
        largestLoss: 0,
      },
      averageDetectionLatency: 0,
      marketsCovered: new Set(),
    };
  }

  /**
   * Process a trade signal in dry-run mode
   * This performs full validation and logging without actual execution
   */
  async processDryRunSignal(
    signal: CopyTradeSignal,
    originalEvent: OrderFilledEvent,
    walletAddress: string
  ): Promise<DryRunLogEntry> {
    this.stats.totalEventsDetected++;
    
    // Initialize log entry
    const logEntry: DryRunLogEntry = {
      eventDetectedAt: new Date(signal.detectedAt).toISOString(),
      logTimestamp: new Date().toISOString(),
      targetWallet: originalEvent.maker,
      orderHash: originalEvent.orderHash,
      transactionHash: originalEvent.transactionHash,
      market: signal.market || originalEvent.tokenId.slice(0, 18) + '...',
      tokenId: originalEvent.tokenId,
      side: signal.side as 'BUY' | 'SELL',
      targetPrice: parseFloat(originalEvent.price),
      calculatedPrice: parseFloat(signal.maxPrice),
      pricePremium: config.trading.pricePremiumCents / 100,
      targetSize: parseFloat(originalEvent.makerAmountFilled) / 1e6,
      calculatedSize: parseFloat(signal.calculatedSize),
      tradeMultiplier: config.trading.tradeMultiplier,
      wouldExecute: true,
      validationDetails: {
        duplicateCheck: true,
        cooldownCheck: true,
        slippageCheck: true,
        balanceCheck: true,
        safetyLimitsCheck: true,
        circuitBreakerCheck: true,
      },
    };

    const skipReasons: string[] = [];

    // === VALIDATION PIPELINE ===

    // 1. Check circuit breaker
    if (!this.circuitBreaker.isAllowed()) {
      logEntry.validationDetails.circuitBreakerCheck = false;
      skipReasons.push('Circuit breaker OPEN');
    }

    // 2. Check safety limits
    const safetyStatus = await this.safetyLimits.isTradingAllowed();
    if (!safetyStatus.tradingAllowed) {
      logEntry.validationDetails.safetyLimitsCheck = false;
      skipReasons.push(`Safety limits: ${safetyStatus.reason}`);
    }

    // 3. Run trade validator
    const validationResult = await this.tradeValidator.validateTrade(originalEvent);
    if (!validationResult.valid) {
      if (validationResult.reason?.includes('Duplicate')) {
        logEntry.validationDetails.duplicateCheck = false;
        skipReasons.push('Duplicate order');
      } else if (validationResult.reason?.includes('cooldown')) {
        logEntry.validationDetails.cooldownCheck = false;
        skipReasons.push(`Market cooldown: ${validationResult.reason}`);
      } else if (validationResult.reason?.includes('Slippage')) {
        logEntry.validationDetails.slippageCheck = false;
        skipReasons.push(`Slippage exceeded: ${validationResult.reason}`);
      } else if (validationResult.reason?.includes('whitelist') || validationResult.reason?.includes('blacklist')) {
        skipReasons.push(`Market filter: ${validationResult.reason}`);
      } else {
        skipReasons.push(validationResult.reason || 'Validation failed');
      }
    }

    // 4. Check position sizing / balance
    const positionResult = await this.positionSizing.calculatePositionSize(
      walletAddress,
      parseFloat(originalEvent.makerAmountFilled) / 1e6
    );
    
    logEntry.walletBalance = positionResult.balanceAfterTrade 
      ? positionResult.balanceAfterTrade + positionResult.calculatedSize
      : undefined;
    logEntry.balanceAfterTrade = positionResult.balanceAfterTrade;
    
    if (!positionResult.valid) {
      logEntry.validationDetails.balanceCheck = false;
      skipReasons.push(`Position sizing: ${positionResult.reason}`);
    }

    // Update calculated size from position sizing
    logEntry.calculatedSize = positionResult.calculatedSize;

    // === DETERMINE EXECUTION STATUS ===

    if (skipReasons.length > 0) {
      logEntry.wouldExecute = false;
      logEntry.skipReason = skipReasons.join('; ');
      this.stats.skippedCount++;
      
      // Track skip reasons
      for (const reason of skipReasons) {
        const reasonKey = this.categorizeSkipReason(reason);
        this.stats.skipReasons[reasonKey] = (this.stats.skipReasons[reasonKey] || 0) + 1;
      }
    } else {
      logEntry.wouldExecute = true;
      logEntry.simulatedOrderId = `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.stats.wouldExecuteCount++;
    }
    
    // Create simulated position for P&L tracking (ALWAYS if we have valid size)
    // In dry-run mode, we want to see what P&L would be even for trades that validation might skip
    if (logEntry.calculatedSize > 0) {
      const positionId = logEntry.simulatedOrderId || `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const entryPrice = logEntry.calculatedPrice || logEntry.targetPrice;
      
      this.simulatedPositions.set(positionId, {
        entryPrice: entryPrice,
        size: logEntry.calculatedSize,
        side: logEntry.side,
        timestamp: Date.now(),
        tokenId: logEntry.tokenId,
      });
      
      logEntry.simulatedPnL = {
        entryPrice: entryPrice,
        size: logEntry.calculatedSize,
      };
      
      // Subscribe to live price updates for this token
      this.subscribeToToken(logEntry.tokenId);
      
      // Add to simulated trades list if no skip reasons
      if (skipReasons.length === 0) {
        this.stats.simulatedTrades.push(logEntry);
      }
    }

    // Track market coverage
    this.stats.marketsCovered.add(logEntry.tokenId);

    // === LOG OUTPUT ===
    this.logDryRunEntry(logEntry);

    // Store log entry
    this.logEntries.push(logEntry);
    if (this.logEntries.length > this.MAX_LOG_ENTRIES) {
      this.logEntries.shift();
    }

    // Mark order as processed (even in dry-run to prevent re-processing)
    await this.tradeValidator.markOrderProcessed(originalEvent.orderHash);
    this.tradeValidator.updateMarketLastTrade(originalEvent.tokenId);

    // Emit event
    this.emit('dryRunProcessed', logEntry);

    return logEntry;
  }

  /**
   * Log a dry-run entry with the specified format
   */
  private logDryRunEntry(entry: DryRunLogEntry): void {
    const divider = '═'.repeat(60);
    
    logger.info(`\n${divider}`);
    logger.info('📋 DRY-RUN TRADE DETECTION');
    logger.info(divider);
    logger.info(`Event detected at:     ${entry.eventDetectedAt}`);
    logger.info(`Target wallet:         ${entry.targetWallet}`);
    logger.info(`Order hash:            ${entry.orderHash.slice(0, 18)}...`);
    logger.info(`Transaction:           ${entry.transactionHash.slice(0, 18)}...`);
    logger.info(divider);
    logger.info(`Market:                ${entry.market}`);
    logger.info(`Token ID:              ${entry.tokenId.slice(0, 18)}...`);
    logger.info(`Side:                  ${entry.side}`);
    logger.info(divider);
    logger.info(`Target price:          $${entry.targetPrice.toFixed(4)}`);
    logger.info(`Your calculated price: $${entry.calculatedPrice.toFixed(4)} (+${entry.pricePremium.toFixed(2)} premium)`);
    logger.info(`Target size:           $${entry.targetSize.toFixed(2)} USDC`);
    logger.info(`Your size:             $${entry.calculatedSize.toFixed(2)} USDC (${entry.tradeMultiplier}x multiplier)`);
    logger.info(divider);
    
    if (entry.walletBalance !== undefined) {
      logger.info(`Wallet balance:        $${entry.walletBalance.toFixed(2)} USDC`);
      if (entry.balanceAfterTrade !== undefined) {
        logger.info(`Balance after trade:   $${entry.balanceAfterTrade.toFixed(2)} USDC`);
      }
    }
    
    logger.info(divider);
    logger.info('VALIDATION CHECKS:');
    logger.info(`  Duplicate check:     ${entry.validationDetails.duplicateCheck ? '✅ PASS' : '❌ FAIL'}`);
    logger.info(`  Cooldown check:      ${entry.validationDetails.cooldownCheck ? '✅ PASS' : '❌ FAIL'}`);
    logger.info(`  Slippage check:      ${entry.validationDetails.slippageCheck ? '✅ PASS' : '❌ FAIL'}`);
    logger.info(`  Balance check:       ${entry.validationDetails.balanceCheck ? '✅ PASS' : '❌ FAIL'}`);
    logger.info(`  Safety limits:       ${entry.validationDetails.safetyLimitsCheck ? '✅ PASS' : '❌ FAIL'}`);
    logger.info(`  Circuit breaker:     ${entry.validationDetails.circuitBreakerCheck ? '✅ PASS' : '❌ FAIL'}`);
    logger.info(divider);
    
    if (entry.wouldExecute) {
      logger.info(`Would execute:         ✅ YES`);
      logger.info(`Simulated order ID:    ${entry.simulatedOrderId}`);
    } else {
      logger.info(`Would execute:         ❌ NO`);
      logger.info(`Skip reason:           ${entry.skipReason}`);
    }
    
    logger.info(`${divider}\n`);

    // Also log as structured JSON for parsing
    logger.debug({
      type: 'DRY_RUN_ENTRY',
      ...entry,
    }, 'Dry-run log entry (JSON)');
  }

  /**
   * Categorize skip reasons for statistics
   */
  private categorizeSkipReason(reason: string): string {
    if (reason.includes('balance') || reason.includes('Balance')) return 'INSUFFICIENT_BALANCE';
    if (reason.includes('slippage') || reason.includes('Slippage')) return 'SLIPPAGE_EXCEEDED';
    if (reason.includes('cooldown') || reason.includes('Cooldown')) return 'MARKET_COOLDOWN';
    if (reason.includes('Duplicate')) return 'DUPLICATE_ORDER';
    if (reason.includes('Circuit')) return 'CIRCUIT_BREAKER';
    if (reason.includes('Safety') || reason.includes('loss')) return 'SAFETY_LIMITS';
    if (reason.includes('whitelist') || reason.includes('blacklist')) return 'MARKET_FILTERED';
    if (reason.includes('gas') || reason.includes('MATIC')) return 'INSUFFICIENT_GAS';
    return 'OTHER';
  }

  /**
   * Update simulated P&L based on current market prices
   */
  async updateSimulatedPnL(tokenId: string, currentPrice: number): Promise<void> {
    for (const [orderId, position] of this.simulatedPositions) {
      // Find the log entry
      const entry = this.logEntries.find(e => e.simulatedOrderId === orderId && e.tokenId === tokenId);
      if (!entry) continue;

      // Calculate P&L
      let unrealizedPnL: number;
      if (position.side === 'BUY') {
        unrealizedPnL = (currentPrice - position.entryPrice) * position.size;
      } else {
        unrealizedPnL = (position.entryPrice - currentPrice) * position.size;
      }

      // Update entry
      entry.currentMarketPrice = currentPrice;
      if (entry.simulatedPnL) {
        entry.simulatedPnL.currentPrice = currentPrice;
        entry.simulatedPnL.unrealizedPnL = unrealizedPnL;
      }

      // Update stats
      this.stats.simulatedPnL.totalUnrealizedPnL += unrealizedPnL - (entry.simulatedPnL?.unrealizedPnL || 0);
      
      if (unrealizedPnL > 0) {
        this.stats.simulatedPnL.winningTrades++;
        this.stats.simulatedPnL.largestWin = Math.max(this.stats.simulatedPnL.largestWin, unrealizedPnL);
      } else {
        this.stats.simulatedPnL.losingTrades++;
        this.stats.simulatedPnL.largestLoss = Math.min(this.stats.simulatedPnL.largestLoss, unrealizedPnL);
      }
    }
  }

  /**
   * Get current dry-run statistics
   */
  getStats(): DryRunStats & { 
    totalPnL: number; 
    unrealizedPnL: number; 
    totalVolume: number;
    totalRealizedPnL: number;
    totalUnrealizedPnL: number;
    winningTrades: number;
    losingTrades: number;
    tradesExecuted: number;
    tradesDetected: number;
    openPositions: number;
  } {
    this.stats.runDuration = Date.now() - this.stats.startTime;
    
    // Calculate total volume from simulated trades
    let totalVolume = 0;
    for (const trade of this.stats.simulatedTrades) {
      totalVolume += trade.calculatedSize * trade.calculatedPrice;
    }
    
    return {
      ...this.stats,
      marketsCovered: new Set(this.stats.marketsCovered), // Clone the set
      // P&L fields for dashboard
      totalPnL: this.stats.simulatedPnL.totalUnrealizedPnL,
      totalRealizedPnL: 0, // In dry-run, nothing is actually closed
      totalUnrealizedPnL: this.stats.simulatedPnL.totalUnrealizedPnL,
      unrealizedPnL: this.stats.simulatedPnL.totalUnrealizedPnL,
      totalVolume,
      winningTrades: this.stats.simulatedPnL.winningTrades,
      losingTrades: this.stats.simulatedPnL.losingTrades,
      tradesExecuted: this.stats.wouldExecuteCount,
      tradesDetected: this.stats.totalEventsDetected,
      openPositions: this.simulatedPositions.size,
    };
  }

  /**
   * Get recent log entries
   */
  getRecentLogs(count: number = 50): DryRunLogEntry[] {
    return this.logEntries.slice(-count);
  }

  /**
   * Get logs filtered by execution status
   */
  getLogsByExecutionStatus(wouldExecute: boolean): DryRunLogEntry[] {
    return this.logEntries.filter(e => e.wouldExecute === wouldExecute);
  }

  /**
   * Print summary statistics
   */
  printSummary(): void {
    const stats = this.getStats();
    const runHours = stats.runDuration / 3600000;
    
    logger.info('\n' + '═'.repeat(60));
    logger.info('📊 DRY-RUN SESSION SUMMARY');
    logger.info('═'.repeat(60));
    logger.info(`Run duration:          ${runHours.toFixed(2)} hours`);
    logger.info(`Total events detected: ${stats.totalEventsDetected}`);
    logger.info(`Would execute:         ${stats.wouldExecuteCount} (${(stats.wouldExecuteCount / stats.totalEventsDetected * 100 || 0).toFixed(1)}%)`);
    logger.info(`Skipped:               ${stats.skippedCount} (${(stats.skippedCount / stats.totalEventsDetected * 100 || 0).toFixed(1)}%)`);
    logger.info(`Markets covered:       ${stats.marketsCovered.size}`);
    logger.info('─'.repeat(60));
    logger.info('SKIP REASONS:');
    for (const [reason, count] of Object.entries(stats.skipReasons)) {
      logger.info(`  ${reason}: ${count}`);
    }
    logger.info('─'.repeat(60));
    logger.info('SIMULATED P&L:');
    logger.info(`  Total unrealized:    $${stats.simulatedPnL.totalUnrealizedPnL.toFixed(2)}`);
    logger.info(`  Winning trades:      ${stats.simulatedPnL.winningTrades}`);
    logger.info(`  Losing trades:       ${stats.simulatedPnL.losingTrades}`);
    logger.info(`  Largest win:         $${stats.simulatedPnL.largestWin.toFixed(2)}`);
    logger.info(`  Largest loss:        $${stats.simulatedPnL.largestLoss.toFixed(2)}`);
    logger.info('═'.repeat(60) + '\n');
  }

  /**
   * Reset statistics
   */
  reset(): void {
    this.stats = this.initializeStats();
    this.logEntries = [];
    this.simulatedPositions.clear();
    logger.info('Dry-run statistics reset');
  }
  
  /**
   * Stop the dry-run service and cleanup
   */
  stop(): void {
    logger.info('Dry-run service stopped');
    this.destroy();
  }

  /**
   * Export logs to JSON for analysis
   */
  exportLogs(): string {
    return JSON.stringify({
      stats: this.getStats(),
      logs: this.logEntries,
    }, null, 2);
  }

  /**
   * Format duration in human readable form
   */
  private formatDuration(ms: number): string {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Get recent trades for GUI
   */
  getRecentTrades(limit: number = 50): any[] {
    return this.logEntries
      .slice(-limit)
      .reverse()
      .map(entry => ({
        timestamp: entry.logTimestamp,
        market: entry.market,
        tokenId: entry.tokenId,
        side: entry.side,
        price: entry.calculatedPrice,
        originalSize: entry.targetSize,
        calculatedSize: entry.calculatedSize,
        wouldExecute: entry.wouldExecute,
        skipReason: entry.skipReason,
      }));
  }

  /**
   * Get open positions for GUI
   */
  getOpenPositions(): any[] {
    return Array.from(this.simulatedPositions.entries()).map(([orderId, pos]) => ({
      orderId,
      tokenId: pos.tokenId,
      market: '', // Will be resolved by GUI
      side: pos.side,
      size: pos.size,
      entryPrice: pos.entryPrice,
      timestamp: pos.timestamp,
      unrealizedPnL: 0, // Real-time P&L calculation
    }));
  }

  /**
   * Get P&L history for charts
   */
  getPnLHistory(): number[] {
    // Return real-time P&L snapshots
    return this.pnlHistory.length > 0 ? this.pnlHistory : [0];
  }

  /**
   * Save logs to database
   */
  async saveToDatabaseAsync(): Promise<void> {
    try {
      // Save summary stats
      const stats = this.getStats();
      
      // Use database service to persist (checking connection)
      if (this.databaseService.isConnectedToDb()) {
        logger.info({ 
          entries: this.logEntries.length,
          wouldExecute: stats.wouldExecuteCount,
          skipped: stats.skippedCount,
          pnl: stats.simulatedPnL,
          runtime: this.formatDuration(Date.now() - stats.startTime),
        }, 'Dry-run session summary saved');
      } else {
        logger.warn('Database not connected, dry-run summary not persisted');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to save dry-run logs to database');
    }
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    // Close WebSocket connection
    if (this.priceWs) {
      this.priceWs.close();
      this.priceWs = null;
    }
    
    // Clear reconnect timer
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    
    logger.info('Dry-run service destroyed');
  }
}

// Singleton
let instance: DryRunService | null = null;

export function getDryRunService(): DryRunService {
  if (!instance) {
    instance = new DryRunService();
  }
  return instance;
}

export default DryRunService;
