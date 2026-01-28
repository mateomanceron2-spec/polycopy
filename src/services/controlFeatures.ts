/**
 * Control Features Service
 * 
 * Handles operational controls:
 * - Kill switch (emergency stop)
 * - Pause/Resume trading
 * - Dry-run mode
 * - Configuration hot-reload
 * - Graceful shutdown
 */

import { EventEmitter } from 'events';
import { watch, FSWatcher } from 'fs';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';
import { getCacheService, CacheService } from './cache.js';

const logger = createChildLogger('ControlFeatures');

export interface ControlStatus {
  killSwitch: boolean;
  paused: boolean;
  dryRunMode: boolean;
  lastConfigReload?: number;
  startedAt: number;
  uptime: number;
}

export interface ConfigOverride {
  key: string;
  value: unknown;
  setAt: number;
  setBy: string;
}

export class ControlFeaturesService extends EventEmitter {
  private cacheService: CacheService;
  
  // State
  private killSwitchActive = false;
  private paused = false;
  private dryRunMode: boolean;
  private startedAt: number;
  
  // Config watcher
  private configWatcher?: FSWatcher;
  private lastConfigReload?: number;
  private configOverrides: Map<string, ConfigOverride> = new Map();
  
  // Shutdown handling
  private isShuttingDown = false;
  private shutdownCallbacks: (() => Promise<void>)[] = [];

  constructor() {
    super();
    this.startedAt = Date.now();
    this.dryRunMode = config.control.dryRunMode;
    this.cacheService = getCacheService();
    
    // Load state from Redis
    this.loadStateFromRedis();
    
    // Setup signal handlers
    this.setupSignalHandlers();
    
    // Setup config watcher if enabled
    if (config.control.enableConfigWatch) {
      this.setupConfigWatcher();
    }
  }

  /**
   * Load control state from Redis
   */
  private async loadStateFromRedis(): Promise<void> {
    try {
      // Load kill switch state
      const killState = await this.cacheService.get(config.control.killSwitchKey);
      if (killState === 'true' || killState === '1') {
        this.killSwitchActive = true;
        logger.warn('Kill switch loaded from Redis: ACTIVE');
      }

      // Load pause state
      const pauseState = await this.cacheService.get(config.control.pauseKey);
      if (pauseState === 'true' || pauseState === '1') {
        this.paused = true;
        logger.warn('Pause state loaded from Redis: PAUSED');
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to load control state from Redis');
    }
  }

  /**
   * Check if trading operations are allowed
   */
  async canTrade(): Promise<{ allowed: boolean; reason?: string }> {
    // First check local state
    if (this.killSwitchActive) {
      return { allowed: false, reason: 'Kill switch is active' };
    }

    if (this.paused) {
      return { allowed: false, reason: 'Trading is paused' };
    }

    if (this.isShuttingDown) {
      return { allowed: false, reason: 'System is shutting down' };
    }

    // Check Redis state (for distributed control)
    try {
      const killState = await this.cacheService.get(config.control.killSwitchKey);
      if (killState === 'true' || killState === '1') {
        this.killSwitchActive = true;
        return { allowed: false, reason: 'Kill switch activated via Redis' };
      }

      const pauseState = await this.cacheService.get(config.control.pauseKey);
      if (pauseState === 'true' || pauseState === '1') {
        this.paused = true;
        return { allowed: false, reason: 'Trading paused via Redis' };
      }
    } catch {
      // If Redis fails, rely on local state
    }

    return { allowed: true };
  }

  /**
   * Check if in dry-run mode
   */
  isDryRun(): boolean {
    return this.dryRunMode;
  }

  /**
   * Activate kill switch
   */
  async activateKillSwitch(reason?: string): Promise<void> {
    this.killSwitchActive = true;
    
    logger.error({ reason }, 'KILL SWITCH ACTIVATED');
    
    try {
      await this.cacheService.set(config.control.killSwitchKey, 'true', 86400 * 7); // 7 days
    } catch {
      // Continue even if cache fails
    }
    
    this.emit('killSwitch', { active: true, reason, timestamp: Date.now() });
  }

  /**
   * Deactivate kill switch
   */
  async deactivateKillSwitch(): Promise<void> {
    this.killSwitchActive = false;
    
    logger.info('Kill switch deactivated');
    
    try {
      await this.cacheService.delete(config.control.killSwitchKey);
    } catch {
      // Ignore
    }
    
    this.emit('killSwitch', { active: false, timestamp: Date.now() });
  }

  /**
   * Pause trading
   */
  async pause(reason?: string): Promise<void> {
    this.paused = true;
    
    logger.warn({ reason }, 'Trading PAUSED');
    
    try {
      await this.cacheService.set(config.control.pauseKey, 'true', 86400); // 24 hours
    } catch {
      // Continue
    }
    
    this.emit('paused', { reason, timestamp: Date.now() });
  }

  /**
   * Resume trading
   */
  async resume(): Promise<void> {
    this.paused = false;
    
    logger.info('Trading RESUMED');
    
    try {
      await this.cacheService.delete(config.control.pauseKey);
    } catch {
      // Ignore
    }
    
    this.emit('resumed', { timestamp: Date.now() });
  }

  /**
   * Toggle dry-run mode
   */
  setDryRunMode(enabled: boolean): void {
    const wasEnabled = this.dryRunMode;
    this.dryRunMode = enabled;
    
    if (wasEnabled !== enabled) {
      logger.info({ dryRunMode: enabled }, 'Dry-run mode changed');
      this.emit('dryRunModeChanged', { enabled, timestamp: Date.now() });
    }
  }

  /**
   * Override a config value at runtime
   */
  setConfigOverride(key: string, value: unknown, setBy: string = 'api'): void {
    this.configOverrides.set(key, {
      key,
      value,
      setAt: Date.now(),
      setBy,
    });
    
    logger.info({ key, value, setBy }, 'Config override set');
    this.emit('configOverride', { key, value, setBy });
  }

  /**
   * Get a config value with override support
   */
  getConfigValue<T>(key: string, defaultValue: T): T {
    const override = this.configOverrides.get(key);
    if (override) {
      return override.value as T;
    }
    return defaultValue;
  }

  /**
   * Clear a config override
   */
  clearConfigOverride(key: string): void {
    this.configOverrides.delete(key);
    logger.info({ key }, 'Config override cleared');
  }

  /**
   * Setup config file watcher
   */
  private setupConfigWatcher(): void {
    const envPath = resolve(process.cwd(), '.env');
    
    try {
      this.configWatcher = watch(envPath, async (eventType) => {
        if (eventType === 'change') {
          logger.info('Config file change detected');
          await this.reloadConfig();
        }
      });
      
      logger.info({ path: envPath }, 'Config watcher started');
    } catch (error) {
      logger.warn({ error }, 'Failed to setup config watcher');
    }
  }

  /**
   * Reload config from .env file
   */
  private async reloadConfig(): Promise<void> {
    try {
      const envPath = resolve(process.cwd(), '.env');
      const envContent = await readFile(envPath, 'utf-8');
      
      // Parse .env content
      const updates: Record<string, string> = {};
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...valueParts] = trimmed.split('=');
          if (key && valueParts.length > 0) {
            updates[key.trim()] = valueParts.join('=').trim();
          }
        }
      }

      // Apply hot-reloadable settings
      const hotReloadKeys = [
        'DRY_RUN_MODE',
        'TRADE_MULTIPLIER',
        'MAX_SLIPPAGE_PERCENT',
        'MARKET_COOLDOWN_SECONDS',
        'DAILY_LOSS_LIMIT',
      ];

      for (const key of hotReloadKeys) {
        if (updates[key] !== undefined) {
          this.setConfigOverride(key, updates[key], 'file-reload');
        }
      }

      this.lastConfigReload = Date.now();
      logger.info({ reloadedKeys: Object.keys(updates).length }, 'Config reloaded');
      
      this.emit('configReloaded', { timestamp: Date.now(), keys: Object.keys(updates) });
    } catch (error) {
      logger.error({ error }, 'Failed to reload config');
    }
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    
    for (const signal of signals) {
      process.on(signal, async () => {
        logger.info({ signal }, 'Received shutdown signal');
        await this.shutdown();
        process.exit(0);
      });
    }
    
    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      logger.error({ error }, 'Uncaught exception');
      await this.shutdown();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
      logger.error({ reason }, 'Unhandled rejection');
      // Don't exit, but log it
    });
  }

  /**
   * Register a shutdown callback
   */
  onShutdown(callback: () => Promise<void>): void {
    this.shutdownCallbacks.push(callback);
  }

  /**
   * Perform graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    
    this.isShuttingDown = true;
    logger.info('Starting graceful shutdown...');
    
    // Stop config watcher
    if (this.configWatcher) {
      this.configWatcher.close();
    }
    
    // Execute shutdown callbacks
    for (const callback of this.shutdownCallbacks) {
      try {
        await callback();
      } catch (error) {
        logger.error({ error }, 'Shutdown callback failed');
      }
    }
    
    this.emit('shutdown');
    logger.info('Shutdown complete');
  }

  /**
   * Get current control status
   */
  getStatus(): ControlStatus {
    return {
      killSwitch: this.killSwitchActive,
      paused: this.paused,
      dryRunMode: this.dryRunMode,
      lastConfigReload: this.lastConfigReload,
      startedAt: this.startedAt,
      uptime: Date.now() - this.startedAt,
    };
  }

  /**
   * Get all config overrides
   */
  getConfigOverrides(): ConfigOverride[] {
    return Array.from(this.configOverrides.values());
  }

  /**
   * Health check
   */
  isHealthy(): boolean {
    return !this.isShuttingDown && !this.killSwitchActive;
  }
}

// Singleton
let instance: ControlFeaturesService | null = null;

export function getControlFeatures(): ControlFeaturesService {
  if (!instance) {
    instance = new ControlFeaturesService();
  }
  return instance;
}

export default ControlFeaturesService;
