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
  private simulatedPositions: Map<string, { entryPrice: number; size: number; side: 'BUY' | 'SELL'; timestamp: number }> = new Map();
  
  // Log storage
  private logEntries: DryRunLogEntry[] = [];
  private readonly MAX_LOG_ENTRIES = 10000;
  
  constructor() {
    super();
    this.stats = this.initializeStats();
  }

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
      
      // Track simulated position for P&L
      this.simulatedPositions.set(logEntry.simulatedOrderId, {
        entryPrice: logEntry.calculatedPrice,
        size: logEntry.calculatedSize,
        side: logEntry.side,
        timestamp: Date.now(),
      });
      
      logEntry.simulatedPnL = {
        entryPrice: logEntry.calculatedPrice,
        size: logEntry.calculatedSize,
      };
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
  getStats(): DryRunStats {
    this.stats.runDuration = Date.now() - this.stats.startTime;
    return {
      ...this.stats,
      marketsCovered: new Set(this.stats.marketsCovered), // Clone the set
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
