/**
 * Safety Limits Service
 * 
 * Implements safety features:
 * - Daily P&L tracking
 * - Daily loss limits
 * - Balance threshold alerts
 * - Max position size enforcement
 * - Trade count limits
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';
import { getCacheService, CacheService } from './cache.js';
import { getDatabaseService, DatabaseService } from './database.js';

const logger = createChildLogger('SafetyLimits');

export interface DailyStats {
  date: string; // YYYY-MM-DD
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalVolume: number;
  realizedPnL: number;
  unrealizedPnL: number;
  fees: number;
  startingBalance: number;
  currentBalance: number;
}

export interface TradeRecord {
  id: string;
  timestamp: number;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  fee: number;
  status: 'FILLED' | 'PARTIAL' | 'FAILED';
  pnl?: number;
}

export interface SafetyStatus {
  tradingAllowed: boolean;
  reason?: string;
  dailyStats: DailyStats;
  warningsTriggered: string[];
}

export class SafetyLimitsService extends EventEmitter {
  private cacheService: CacheService;
  private dbService: DatabaseService;
  
  // Daily stats
  private currentDayStats: DailyStats;
  
  // Cache keys
  private readonly DAILY_STATS_PREFIX = 'safety:daily:';
  private readonly KILL_TRIGGER_KEY = 'safety:killTriggered';
  
  // Track warnings to avoid spam
  private triggeredWarnings: Set<string> = new Set();
  private warningCooldowns: Map<string, number> = new Map();
  private readonly WARNING_COOLDOWN_MS = 300000; // 5 minutes

  constructor() {
    super();
    this.cacheService = getCacheService();
    this.dbService = getDatabaseService();
    this.currentDayStats = this.createEmptyDailyStats();
    this.loadTodayStats();
  }

  /**
   * Create empty daily stats
   */
  private createEmptyDailyStats(): DailyStats {
    const today = new Date().toISOString().split('T')[0];
    return {
      date: today,
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalVolume: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      fees: 0,
      startingBalance: 0,
      currentBalance: 0,
    };
  }

  /**
   * Load today's stats from storage
   */
  private async loadTodayStats(): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    const cacheKey = `${this.DAILY_STATS_PREFIX}${today}`;
    
    try {
      // Try cache first
      const cached = await this.cacheService.get(cacheKey);
      if (cached) {
        this.currentDayStats = JSON.parse(cached);
        logger.info({ stats: this.currentDayStats }, 'Daily stats loaded from cache');
        return;
      }

      // Try database
      const stats = await this.dbService.getDailyStats(today);
      if (stats) {
        this.currentDayStats = stats;
        await this.saveTodayStats();
        logger.info({ stats }, 'Daily stats loaded from database');
        return;
      }

      // No existing stats, keep empty
      logger.info('No existing daily stats, starting fresh');
    } catch (error) {
      logger.warn({ error }, 'Failed to load daily stats');
    }
  }

  /**
   * Save today's stats
   */
  private async saveTodayStats(): Promise<void> {
    const cacheKey = `${this.DAILY_STATS_PREFIX}${this.currentDayStats.date}`;
    
    try {
      // Save to cache with 24 hour TTL
      await this.cacheService.set(cacheKey, JSON.stringify(this.currentDayStats), 86400);
      
      // Save to database periodically (don't await to avoid blocking)
      this.dbService.saveDailyStats(this.currentDayStats).catch(err => {
        logger.warn({ error: err }, 'Failed to persist daily stats to database');
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to save daily stats to cache');
    }
  }

  /**
   * Record a completed trade
   */
  async recordTrade(trade: TradeRecord): Promise<void> {
    // Check if we need to roll over to new day
    this.checkDayRollover();
    
    this.currentDayStats.totalTrades++;
    
    if (trade.status === 'FILLED' || trade.status === 'PARTIAL') {
      this.currentDayStats.successfulTrades++;
      this.currentDayStats.totalVolume += trade.size * trade.price;
      this.currentDayStats.fees += trade.fee;
      
      if (trade.pnl !== undefined) {
        this.currentDayStats.realizedPnL += trade.pnl;
      }
    } else {
      this.currentDayStats.failedTrades++;
    }
    
    await this.saveTodayStats();
    
    // Check limits after trade
    await this.checkAllLimits();
    
    logger.debug({
      tradeId: trade.id,
      dailyPnL: this.currentDayStats.realizedPnL,
      dailyTrades: this.currentDayStats.totalTrades,
    }, 'Trade recorded');
  }

  /**
   * Update current balance
   */
  async updateBalance(balance: number): Promise<void> {
    if (this.currentDayStats.startingBalance === 0) {
      this.currentDayStats.startingBalance = balance;
    }
    this.currentDayStats.currentBalance = balance;
    
    await this.saveTodayStats();
    await this.checkBalanceLimits(balance);
  }

  /**
   * Check if trading is allowed
   */
  async isTradingAllowed(): Promise<SafetyStatus> {
    this.checkDayRollover();
    
    const warnings: string[] = [];
    let allowed = true;
    let reason: string | undefined;

    // 1. Check if kill switch was triggered
    try {
      const killTriggered = await this.cacheService.get(this.KILL_TRIGGER_KEY);
      if (killTriggered === 'true') {
        return {
          tradingAllowed: false,
          reason: 'Safety kill switch triggered - daily loss limit exceeded',
          dailyStats: this.currentDayStats,
          warningsTriggered: ['KILL_SWITCH'],
        };
      }
    } catch {
      // Continue if cache unavailable
    }

    // 2. Check daily loss limit
    const dailyLoss = -this.currentDayStats.realizedPnL;
    const lossLimitUsdc = config.trading.dailyLossLimit;
    
    if (dailyLoss >= lossLimitUsdc) {
      allowed = false;
      reason = `Daily loss limit reached: $${dailyLoss.toFixed(2)} >= $${lossLimitUsdc}`;
      warnings.push('DAILY_LOSS_LIMIT');
      
      // Trigger kill switch
      await this.triggerSafetyStop('Daily loss limit exceeded');
    } else if (dailyLoss >= lossLimitUsdc * 0.8) {
      // 80% warning
      this.emitWarning('LOSS_WARNING_80', `Approaching daily loss limit: $${dailyLoss.toFixed(2)} / $${lossLimitUsdc}`);
      warnings.push('LOSS_WARNING_80');
    } else if (dailyLoss >= lossLimitUsdc * 0.5) {
      // 50% warning
      this.emitWarning('LOSS_WARNING_50', `50% of daily loss limit used: $${dailyLoss.toFixed(2)} / $${lossLimitUsdc}`);
      warnings.push('LOSS_WARNING_50');
    }

    // 3. Check minimum balance
    const minBalance = config.wallet.minBalance;
    if (this.currentDayStats.currentBalance > 0 && this.currentDayStats.currentBalance < minBalance) {
      allowed = false;
      reason = `Balance below minimum: $${this.currentDayStats.currentBalance.toFixed(2)} < $${minBalance}`;
      warnings.push('BALANCE_TOO_LOW');
    }

    return {
      tradingAllowed: allowed,
      reason,
      dailyStats: this.currentDayStats,
      warningsTriggered: warnings,
    };
  }

  /**
   * Validate a trade before execution
   */
  async validateTradeSize(
    size: number,
    price: number,
    balance: number
  ): Promise<{ valid: boolean; reason?: string }> {
    const tradeValue = size * price;
    
    // Check max position percentage
    const maxPositionValue = balance * (config.trading.maxPositionPercent / 100);
    if (tradeValue > maxPositionValue) {
      return {
        valid: false,
        reason: `Trade value $${tradeValue.toFixed(2)} exceeds max position $${maxPositionValue.toFixed(2)}`,
      };
    }

    // Check min trade size
    if (tradeValue < config.trading.minTradeSize) {
      return {
        valid: false,
        reason: `Trade value $${tradeValue.toFixed(2)} below minimum $${config.trading.minTradeSize}`,
      };
    }

    // Check if trade would put us over daily loss limit
    const remainingRisk = config.trading.dailyLossLimit - (-this.currentDayStats.realizedPnL);
    if (tradeValue > remainingRisk * 2) { // Conservative: trade shouldn't risk more than 50% of remaining limit
      return {
        valid: false,
        reason: `Trade too risky for remaining daily limit: $${tradeValue.toFixed(2)} vs $${remainingRisk.toFixed(2)} remaining`,
      };
    }

    return { valid: true };
  }

  /**
   * Check all safety limits
   */
  private async checkAllLimits(): Promise<void> {
    const status = await this.isTradingAllowed();
    
    if (!status.tradingAllowed) {
      this.emit('tradingPaused', { reason: status.reason, stats: status.dailyStats });
    }
  }

  /**
   * Check balance limits
   */
  private async checkBalanceLimits(balance: number): Promise<void> {
    const minBalance = config.wallet.minBalance;
    
    // Critical warning at 25% above minimum
    if (balance < minBalance * 1.25 && balance >= minBalance) {
      this.emitWarning('LOW_BALANCE_WARNING', `Balance approaching minimum: $${balance.toFixed(2)}`);
    }
    
    // Alert if significantly below starting balance
    if (this.currentDayStats.startingBalance > 0) {
      const drawdown = (1 - balance / this.currentDayStats.startingBalance) * 100;
      
      if (drawdown >= 10) {
        this.emitWarning('DRAWDOWN_10', `Daily drawdown exceeds 10%: ${drawdown.toFixed(1)}%`);
      } else if (drawdown >= 5) {
        this.emitWarning('DRAWDOWN_5', `Daily drawdown exceeds 5%: ${drawdown.toFixed(1)}%`);
      }
    }
  }

  /**
   * Emit a warning (with cooldown to prevent spam)
   */
  private emitWarning(type: string, message: string): void {
    const now = Date.now();
    const lastWarning = this.warningCooldowns.get(type) || 0;
    
    if (now - lastWarning >= this.WARNING_COOLDOWN_MS) {
      this.warningCooldowns.set(type, now);
      this.triggeredWarnings.add(type);
      
      logger.warn({ type, message }, 'Safety warning');
      this.emit('warning', { type, message, timestamp: now });
    }
  }

  /**
   * Trigger safety stop
   */
  private async triggerSafetyStop(reason: string): Promise<void> {
    logger.error({ reason }, 'SAFETY STOP TRIGGERED');
    
    try {
      await this.cacheService.set(this.KILL_TRIGGER_KEY, 'true', 86400); // 24 hour
    } catch {
      // Continue even if cache fails
    }
    
    this.emit('safetyStop', { 
      reason, 
      stats: this.currentDayStats,
      timestamp: Date.now(),
    });
  }

  /**
   * Reset safety stop (admin action)
   */
  async resetSafetyStop(): Promise<void> {
    try {
      await this.cacheService.delete(this.KILL_TRIGGER_KEY);
    } catch {
      // Ignore
    }
    
    this.triggeredWarnings.clear();
    this.warningCooldowns.clear();
    
    logger.info('Safety stop reset');
    this.emit('safetyReset');
  }

  /**
   * Check if day has rolled over
   */
  private checkDayRollover(): void {
    const today = new Date().toISOString().split('T')[0];
    
    if (this.currentDayStats.date !== today) {
      logger.info({
        previousDay: this.currentDayStats.date,
        newDay: today,
        finalStats: this.currentDayStats,
      }, 'Day rollover detected');
      
      // Archive previous day stats
      this.dbService.saveDailyStats(this.currentDayStats).catch(err => {
        logger.warn({ error: err }, 'Failed to archive previous day stats');
      });
      
      // Reset for new day
      this.currentDayStats = this.createEmptyDailyStats();
      this.triggeredWarnings.clear();
      this.warningCooldowns.clear();
      
      // Clear kill switch on new day
      this.cacheService.delete(this.KILL_TRIGGER_KEY).catch(() => {});
      
      this.emit('dayRollover', { newDate: today });
    }
  }

  /**
   * Get current daily stats
   */
  getDailyStats(): DailyStats {
    this.checkDayRollover();
    return { ...this.currentDayStats };
  }

  /**
   * Get historical stats
   */
  async getHistoricalStats(days: number = 7): Promise<DailyStats[]> {
    return this.dbService.getHistoricalStats(days);
  }

  /**
   * Calculate P&L from a position close
   */
  calculatePnL(
    entryPrice: number,
    exitPrice: number,
    size: number,
    side: 'BUY' | 'SELL'
  ): number {
    if (side === 'BUY') {
      // Bought then sold: profit if exit > entry
      return (exitPrice - entryPrice) * size;
    } else {
      // Sold then bought back: profit if exit < entry
      return (entryPrice - exitPrice) * size;
    }
  }

  /**
   * Shutdown
   */
  async shutdown(): Promise<void> {
    // Final save
    await this.saveTodayStats();
    logger.info('Safety limits service shutdown');
  }
}

// Singleton
let instance: SafetyLimitsService | null = null;

export function getSafetyLimits(): SafetyLimitsService {
  if (!instance) {
    instance = new SafetyLimitsService();
  }
  return instance;
}

export default SafetyLimitsService;
