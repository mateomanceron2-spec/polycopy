/**
 * Circuit Breaker Service
 * 
 * Implements circuit breaker pattern for error handling:
 * - Tracks consecutive failures
 * - Automatically pauses trading after threshold
 * - Auto-recovery after pause period
 * - Rate limiting for requests
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';
import { getCacheService, CacheService } from './cache.js';

const logger = createChildLogger('CircuitBreaker');

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerStatus {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  openedAt?: number;
  willCloseAt?: number;
  totalFailures: number;
  totalSuccesses: number;
  failureRate: number;
}

export interface FailureDetails {
  timestamp: number;
  error: string;
  context?: Record<string, unknown>;
}

export class CircuitBreakerService extends EventEmitter {
  private cacheService: CacheService;
  
  // Circuit state
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureTime?: number;
  private lastSuccessTime?: number;
  private openedAt?: number;
  
  // Stats
  private totalFailures = 0;
  private totalSuccesses = 0;
  
  // Failure history (for analysis)
  private failureHistory: FailureDetails[] = [];
  private readonly MAX_HISTORY_SIZE = 100;
  
  // Recovery timer
  private recoveryTimer?: NodeJS.Timeout;
  
  // Redis keys
  private readonly CIRCUIT_STATE_KEY = 'circuit:state';
  private readonly CIRCUIT_OPENED_AT_KEY = 'circuit:openedAt';
  
  constructor() {
    super();
    this.cacheService = getCacheService();
    this.loadStateFromRedis();
  }

  /**
   * Load circuit state from Redis (for distributed systems)
   */
  private async loadStateFromRedis(): Promise<void> {
    try {
      const savedState = await this.cacheService.get(this.CIRCUIT_STATE_KEY);
      const savedOpenedAt = await this.cacheService.get(this.CIRCUIT_OPENED_AT_KEY);
      
      if (savedState === 'OPEN' && savedOpenedAt) {
        const openedAtTime = parseInt(savedOpenedAt, 10);
        const pauseDuration = config.trading.circuitBreakerPauseMinutes * 60 * 1000;
        const shouldCloseAt = openedAtTime + pauseDuration;
        
        if (Date.now() < shouldCloseAt) {
          // Still in pause period
          this.state = 'OPEN';
          this.openedAt = openedAtTime;
          this.scheduleRecovery(shouldCloseAt - Date.now());
          logger.warn({
            remainingMs: shouldCloseAt - Date.now(),
          }, 'Circuit breaker loaded from Redis in OPEN state');
        } else {
          // Pause period expired, try half-open
          this.transitionToHalfOpen();
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to load circuit state from Redis');
    }
  }

  /**
   * Record a successful operation
   */
  recordSuccess(): void {
    this.totalSuccesses++;
    this.lastSuccessTime = Date.now();
    
    if (this.state === 'HALF_OPEN') {
      // Success in half-open state closes the circuit
      this.transitionToClosed();
    }
    
    // Reset consecutive failures on success
    if (this.consecutiveFailures > 0) {
      logger.info({
        previousFailures: this.consecutiveFailures,
      }, 'Consecutive failures reset after success');
      this.consecutiveFailures = 0;
    }
  }

  /**
   * Record a failed operation
   */
  recordFailure(error: string, context?: Record<string, unknown>): void {
    this.totalFailures++;
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    
    // Store failure details
    this.failureHistory.push({
      timestamp: Date.now(),
      error,
      context,
    });
    
    if (this.failureHistory.length > this.MAX_HISTORY_SIZE) {
      this.failureHistory.shift();
    }
    
    logger.warn({
      consecutiveFailures: this.consecutiveFailures,
      threshold: config.trading.maxConsecutiveFailures,
      error,
    }, 'Failure recorded');

    // Check if we should open the circuit
    if (this.state === 'CLOSED' || this.state === 'HALF_OPEN') {
      if (this.consecutiveFailures >= config.trading.maxConsecutiveFailures) {
        this.transitionToOpen();
      }
    }
  }

  /**
   * Check if trading is allowed
   */
  isAllowed(): boolean {
    if (this.state === 'OPEN') {
      return false;
    }
    
    if (this.state === 'HALF_OPEN') {
      // In half-open, allow limited requests to test recovery
      return true;
    }
    
    return true;
  }

  /**
   * Transition to OPEN state (trading paused)
   */
  private transitionToOpen(): void {
    this.state = 'OPEN';
    this.openedAt = Date.now();
    
    const pauseMs = config.trading.circuitBreakerPauseMinutes * 60 * 1000;
    
    logger.error({
      consecutiveFailures: this.consecutiveFailures,
      pauseMinutes: config.trading.circuitBreakerPauseMinutes,
    }, 'Circuit breaker OPENED - trading paused');
    
    // Save to Redis
    this.saveStateToRedis();
    
    // Schedule recovery
    this.scheduleRecovery(pauseMs);
    
    // Emit event
    this.emit('opened', {
      consecutiveFailures: this.consecutiveFailures,
      pauseMinutes: config.trading.circuitBreakerPauseMinutes,
      recentFailures: this.failureHistory.slice(-5),
    });
  }

  /**
   * Transition to HALF_OPEN state (testing recovery)
   */
  private transitionToHalfOpen(): void {
    this.state = 'HALF_OPEN';
    
    logger.info('Circuit breaker transitioning to HALF_OPEN - testing recovery');
    
    this.emit('halfOpen', {
      consecutiveFailures: this.consecutiveFailures,
      openDurationMs: this.openedAt ? Date.now() - this.openedAt : 0,
    });
  }

  /**
   * Transition to CLOSED state (trading resumed)
   */
  private transitionToClosed(): void {
    const wasOpen = this.state === 'OPEN' || this.state === 'HALF_OPEN';
    
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    
    // Clear Redis state
    this.clearStateFromRedis();
    
    if (wasOpen) {
      logger.info('Circuit breaker CLOSED - trading resumed');
      this.emit('closed', {
        totalSuccesses: this.totalSuccesses,
        totalFailures: this.totalFailures,
      });
    }
  }

  /**
   * Schedule automatic recovery attempt
   */
  private scheduleRecovery(delayMs: number): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
    }
    
    this.recoveryTimer = setTimeout(() => {
      if (this.state === 'OPEN') {
        this.transitionToHalfOpen();
      }
    }, delayMs);
    
    logger.info({
      recoveryInMs: delayMs,
      recoveryAt: new Date(Date.now() + delayMs).toISOString(),
    }, 'Circuit recovery scheduled');
  }

  /**
   * Manually reset the circuit breaker
   */
  manualReset(): void {
    logger.info('Circuit breaker manually reset');
    this.transitionToClosed();
    this.failureHistory = [];
    this.emit('manualReset');
  }

  /**
   * Force open the circuit (manual pause)
   */
  forceOpen(durationMinutes?: number): void {
    this.state = 'OPEN';
    this.openedAt = Date.now();
    
    const pauseMs = (durationMinutes || config.trading.circuitBreakerPauseMinutes) * 60 * 1000;
    
    logger.warn({
      durationMinutes: durationMinutes || config.trading.circuitBreakerPauseMinutes,
    }, 'Circuit breaker force opened');
    
    this.saveStateToRedis();
    this.scheduleRecovery(pauseMs);
    
    this.emit('forceOpened', { durationMinutes });
  }

  /**
   * Save circuit state to Redis
   */
  private async saveStateToRedis(): Promise<void> {
    try {
      await this.cacheService.set(this.CIRCUIT_STATE_KEY, this.state, 86400); // 24 hour TTL
      if (this.openedAt) {
        await this.cacheService.set(this.CIRCUIT_OPENED_AT_KEY, this.openedAt.toString(), 86400);
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to save circuit state to Redis');
    }
  }

  /**
   * Clear circuit state from Redis
   */
  private async clearStateFromRedis(): Promise<void> {
    try {
      await this.cacheService.delete(this.CIRCUIT_STATE_KEY);
      await this.cacheService.delete(this.CIRCUIT_OPENED_AT_KEY);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Get current status
   */
  getStatus(): CircuitBreakerStatus {
    const total = this.totalSuccesses + this.totalFailures;
    const willCloseAt = this.openedAt 
      ? this.openedAt + (config.trading.circuitBreakerPauseMinutes * 60 * 1000)
      : undefined;
    
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      openedAt: this.openedAt,
      willCloseAt: this.state === 'OPEN' ? willCloseAt : undefined,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      failureRate: total > 0 ? (this.totalFailures / total) * 100 : 0,
    };
  }

  /**
   * Get recent failure history
   */
  getRecentFailures(count = 10): FailureDetails[] {
    return this.failureHistory.slice(-count);
  }

  /**
   * Shutdown
   */
  shutdown(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    logger.info('Circuit breaker shutdown');
  }
}

// Singleton
let instance: CircuitBreakerService | null = null;

export function getCircuitBreaker(): CircuitBreakerService {
  if (!instance) {
    instance = new CircuitBreakerService();
  }
  return instance;
}

export default CircuitBreakerService;
