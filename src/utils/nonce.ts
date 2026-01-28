import { getRPCService } from '../services/rpc.js';
import { getCacheService } from '../services/cache.js';
import { createChildLogger } from './logger.js';
import type { NonceState } from '../config/types.js';

const logger = createChildLogger('NonceManager');

export class NonceManager {
  private address: string;
  private rpcService = getRPCService();
  private cacheService = getCacheService();
  private pendingNonces: Set<number> = new Set();
  private lastSync = 0;
  private readonly SYNC_INTERVAL = 10000; // 10 seconds

  constructor(address: string) {
    this.address = address.toLowerCase();
  }

  /**
   * Initialize nonce from network
   */
  async initialize(): Promise<void> {
    const networkNonce = await this.rpcService.getNonce(this.address);
    
    const state: NonceState = {
      current: networkNonce,
      pending: networkNonce,
      lastUpdated: Date.now(),
    };

    await this.cacheService.setNonce(this.address, state);
    this.lastSync = Date.now();
    
    logger.info({ address: this.address, nonce: networkNonce }, 'Nonce initialized');
  }

  /**
   * Get next available nonce for transaction
   */
  async getNextNonce(): Promise<number> {
    // Sync with network periodically
    if (Date.now() - this.lastSync > this.SYNC_INTERVAL) {
      await this.syncWithNetwork();
    }

    let state = await this.cacheService.getNonce(this.address);
    
    if (!state) {
      await this.initialize();
      state = await this.cacheService.getNonce(this.address);
    }

    if (!state) {
      throw new Error('Failed to get nonce state');
    }

    // Find next available nonce (skip pending ones)
    let nextNonce = state.pending;
    while (this.pendingNonces.has(nextNonce)) {
      nextNonce++;
    }

    // Mark as pending
    this.pendingNonces.add(nextNonce);

    // Update cache
    state.pending = nextNonce + 1;
    state.lastUpdated = Date.now();
    await this.cacheService.setNonce(this.address, state);

    logger.debug({ nonce: nextNonce }, 'Nonce allocated');
    return nextNonce;
  }

  /**
   * Mark nonce as confirmed (transaction mined)
   */
  async confirmNonce(nonce: number): Promise<void> {
    this.pendingNonces.delete(nonce);
    
    const state = await this.cacheService.getNonce(this.address);
    if (state && nonce >= state.current) {
      state.current = nonce + 1;
      state.lastUpdated = Date.now();
      await this.cacheService.setNonce(this.address, state);
    }

    logger.debug({ nonce }, 'Nonce confirmed');
  }

  /**
   * Release nonce (transaction failed/cancelled)
   */
  releaseNonce(nonce: number): void {
    this.pendingNonces.delete(nonce);
    logger.debug({ nonce }, 'Nonce released');
  }

  /**
   * Sync nonce with network
   */
  async syncWithNetwork(): Promise<void> {
    try {
      const networkNonce = await this.rpcService.getNonce(this.address);
      const state = await this.cacheService.getNonce(this.address);

      if (state) {
        // If network is ahead, update our state
        if (networkNonce > state.current) {
          state.current = networkNonce;
          if (networkNonce > state.pending) {
            state.pending = networkNonce;
          }
          state.lastUpdated = Date.now();
          await this.cacheService.setNonce(this.address, state);
          
          // Clear pending nonces that are now confirmed
          for (const nonce of this.pendingNonces) {
            if (nonce < networkNonce) {
              this.pendingNonces.delete(nonce);
            }
          }
          
          logger.info({ networkNonce, localNonce: state.pending }, 'Nonce synced with network');
        }
      }

      this.lastSync = Date.now();
    } catch (error) {
      logger.error({ error }, 'Failed to sync nonce with network');
    }
  }

  /**
   * Get current nonce state
   */
  async getState(): Promise<NonceState | null> {
    return this.cacheService.getNonce(this.address);
  }

  /**
   * Get pending nonces count
   */
  getPendingCount(): number {
    return this.pendingNonces.size;
  }
}

// Factory to create NonceManager instances
const nonceManagers: Map<string, NonceManager> = new Map();

export function getNonceManager(address: string): NonceManager {
  const key = address.toLowerCase();
  let manager = nonceManagers.get(key);
  
  if (!manager) {
    manager = new NonceManager(address);
    nonceManagers.set(key, manager);
  }
  
  return manager;
}

export default NonceManager;
