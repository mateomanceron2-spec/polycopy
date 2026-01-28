/**
 * Multi-RPC Provider Manager with Failover
 * 
 * Features:
 * - Primary/Secondary/Tertiary provider hierarchy
 * - Automatic failover on connection failure
 * - WebSocket connection with exponential backoff reconnection
 * - HTTP polling fallback mode
 * - Health monitoring and alerting
 * - Connection uptime tracking
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { JsonRpcProvider } from 'ethers';
import config from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { POLYGON_CHAIN_ID } from '../config/constants.js';

const logger = createChildLogger('RPCProviderManager');

// Provider priority order
export enum ProviderPriority {
  PRIMARY = 0,    // Infura
  SECONDARY = 1,  // Polygon Public
  TERTIARY = 2,   // Alchemy
}

export interface ProviderConfig {
  name: string;
  httpUrl: string;
  wsUrl?: string;
  priority: ProviderPriority;
  enabled: boolean;
}

export interface ProviderStatus {
  name: string;
  priority: ProviderPriority;
  httpHealthy: boolean;
  wsConnected: boolean;
  lastSuccessfulRequest: number;
  lastError?: string;
  latencyMs: number;
  requestCount: number;
  errorCount: number;
}

export interface ConnectionMetrics {
  totalConnections: number;
  successfulConnections: number;
  failedConnections: number;
  totalReconnects: number;
  uptimeMs: number;
  downtimeMs: number;
  uptimePercentage: number;
  lastConnectionTime: number;
  lastDisconnectionTime: number;
}

// Events emitted by the manager
export interface RPCProviderManagerEvents {
  connected: (provider: string) => void;
  disconnected: (provider: string, reason: string) => void;
  failover: (from: string, to: string) => void;
  degraded: (message: string) => void;
  restored: (provider: string) => void;
  alert: (message: string, severity: 'warning' | 'critical') => void;
  log: (event: { subscription: string; result: unknown }) => void;
}

export class RPCProviderManager extends EventEmitter {
  // Provider configurations
  private providers: Map<ProviderPriority, ProviderConfig> = new Map();
  private providerStatus: Map<ProviderPriority, ProviderStatus> = new Map();
  
  // Active connections
  private activeWsProvider: WebSocket | null = null;
  private activeHttpProvider: JsonRpcProvider | null = null;
  private activeProviderPriority: ProviderPriority | null = null;
  
  // WebSocket state
  private wsSubscriptionId: string | null = null;
  private wsMessageId = 1;
  private isConnecting = false;
  private isManualClose = false;
  
  // Reconnection state
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3; // Before switching to HTTP fallback
  private reconnectTimer: NodeJS.Timeout | null = null;
  private wsBackgroundReconnectTimer: NodeJS.Timeout | null = null;
  
  // HTTP polling fallback
  private isHttpPollingMode = false;
  private httpPollingInterval: NodeJS.Timeout | null = null;
  
  // Health monitoring
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastEventTime = 0;
  private noEventAlertSent = false;
  
  // Connection metrics
  private metrics: ConnectionMetrics = {
    totalConnections: 0,
    successfulConnections: 0,
    failedConnections: 0,
    totalReconnects: 0,
    uptimeMs: 0,
    downtimeMs: 0,
    uptimePercentage: 100,
    lastConnectionTime: 0,
    lastDisconnectionTime: 0,
  };
  
  // Uptime tracking
  private connectionStartTime = 0;
  private totalUptimeMs = 0;
  private totalDowntimeMs = 0;
  private dailyUptimeCheckStart = Date.now();
  
  // Constants
  private readonly RECONNECT_BASE_DELAY = 1000;     // 1 second
  private readonly RECONNECT_MAX_DELAY = 30000;     // 30 seconds
  private readonly HEARTBEAT_INTERVAL = 30000;      // 30 seconds
  private readonly HEALTH_CHECK_INTERVAL = 10000;   // 10 seconds
  private readonly NO_EVENT_ALERT_THRESHOLD = 120000; // 120 seconds
  private readonly WS_RECONNECT_BACKGROUND_INTERVAL = 60000; // 60 seconds
  private readonly UPTIME_ALERT_THRESHOLD = 95;     // 95%

  constructor() {
    super();
    this.setMaxListeners(50);
    this.initializeProviders();
  }

  /**
   * Initialize provider configurations from config
   */
  private initializeProviders(): void {
    // Primary: Infura
    if (config.rpc.infura.projectId) {
      this.providers.set(ProviderPriority.PRIMARY, {
        name: 'Infura',
        httpUrl: `${config.rpc.infura.url}${config.rpc.infura.projectId}`,
        wsUrl: `${config.rpc.infura.wsUrl}${config.rpc.infura.projectId}`,
        priority: ProviderPriority.PRIMARY,
        enabled: true,
      });
      this.initializeStatus(ProviderPriority.PRIMARY, 'Infura');
    }

    // Secondary: Polygon Public RPC (free, no WebSocket)
    this.providers.set(ProviderPriority.SECONDARY, {
      name: 'Polygon Public',
      httpUrl: config.rpc.polygonPublic?.url || 'https://polygon-rpc.com',
      wsUrl: undefined, // No WebSocket available
      priority: ProviderPriority.SECONDARY,
      enabled: true,
    });
    this.initializeStatus(ProviderPriority.SECONDARY, 'Polygon Public');

    // Tertiary: Alchemy (optional)
    if (config.rpc.alchemy?.apiKey) {
      this.providers.set(ProviderPriority.TERTIARY, {
        name: 'Alchemy',
        httpUrl: `https://polygon-mainnet.g.alchemy.com/v2/${config.rpc.alchemy.apiKey}`,
        wsUrl: `wss://polygon-mainnet.g.alchemy.com/v2/${config.rpc.alchemy.apiKey}`,
        priority: ProviderPriority.TERTIARY,
        enabled: true,
      });
      this.initializeStatus(ProviderPriority.TERTIARY, 'Alchemy');
    }

    logger.info({ 
      providers: Array.from(this.providers.values()).map(p => p.name),
    }, 'RPC providers initialized');
  }

  /**
   * Initialize status for a provider
   */
  private initializeStatus(priority: ProviderPriority, name: string): void {
    this.providerStatus.set(priority, {
      name,
      priority,
      httpHealthy: false,
      wsConnected: false,
      lastSuccessfulRequest: 0,
      latencyMs: 0,
      requestCount: 0,
      errorCount: 0,
    });
  }

  /**
   * Connect to RPC providers (WebSocket primary, HTTP fallback)
   */
  async connect(): Promise<void> {
    logger.info('Connecting to RPC providers...');
    
    // Try to connect to WebSocket in priority order
    for (const [priority, provider] of this.providers) {
      if (!provider.enabled || !provider.wsUrl) continue;
      
      try {
        await this.connectWebSocket(priority);
        return; // Successfully connected
      } catch (error) {
        logger.warn({ 
          provider: provider.name, 
          error: (error as Error).message,
        }, 'Failed to connect to WebSocket provider');
      }
    }

    // No WebSocket available, fall back to HTTP polling
    logger.warn('No WebSocket connection available, falling back to HTTP polling');
    await this.startHttpPolling();
  }

  /**
   * Connect to WebSocket provider
   */
  private async connectWebSocket(priority: ProviderPriority): Promise<void> {
    const provider = this.providers.get(priority);
    if (!provider?.wsUrl) {
      throw new Error(`No WebSocket URL for provider ${priority}`);
    }

    if (this.isConnecting) {
      throw new Error('Connection already in progress');
    }

    this.isConnecting = true;
    this.isManualClose = false;
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      try {
        const wsUrl = provider.wsUrl!;
        logger.info({ 
          provider: provider.name,
          url: wsUrl.replace(/[a-f0-9]{32}/gi, '***'),
        }, 'Connecting to WebSocket RPC');

        this.activeWsProvider = new WebSocket(wsUrl, {
          handshakeTimeout: 10000,
        });

        const connectionTimeout = setTimeout(() => {
          if (this.activeWsProvider?.readyState !== WebSocket.OPEN) {
            this.activeWsProvider?.close();
            reject(new Error('Connection timeout'));
          }
        }, 15000);

        this.activeWsProvider.on('open', () => {
          clearTimeout(connectionTimeout);
          const latency = Date.now() - startTime;
          
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.activeProviderPriority = priority;
          this.isHttpPollingMode = false;
          this.stopHttpPolling();
          
          // Update metrics
          this.metrics.totalConnections++;
          this.metrics.successfulConnections++;
          this.metrics.lastConnectionTime = Date.now();
          this.connectionStartTime = Date.now();
          
          // Update status
          const status = this.providerStatus.get(priority);
          if (status) {
            status.wsConnected = true;
            status.httpHealthy = true;
            status.latencyMs = latency;
            status.lastSuccessfulRequest = Date.now();
          }

          logger.info({ 
            provider: provider.name, 
            latency,
          }, 'WebSocket RPC connected');

          // Start heartbeat
          this.startHeartbeat();
          
          // Start health monitoring
          this.startHealthMonitoring();

          this.emit('connected', provider.name);
          resolve();
        });

        this.activeWsProvider.on('message', (data: WebSocket.RawData) => {
          this.handleWebSocketMessage(data);
        });

        this.activeWsProvider.on('close', (code: number, reason: Buffer) => {
          clearTimeout(connectionTimeout);
          this.isConnecting = false;
          const reasonStr = reason.toString() || 'Unknown reason';
          
          // Update metrics
          if (this.connectionStartTime > 0) {
            this.totalUptimeMs += Date.now() - this.connectionStartTime;
          }
          this.metrics.lastDisconnectionTime = Date.now();
          this.connectionStartTime = 0;
          
          // Update status
          const status = this.providerStatus.get(priority);
          if (status) {
            status.wsConnected = false;
          }

          logger.warn({ code, reason: reasonStr }, 'WebSocket RPC disconnected');
          this.cleanup();
          this.emit('disconnected', provider.name, reasonStr);
          
          if (!this.isManualClose) {
            this.scheduleReconnect();
          }
        });

        this.activeWsProvider.on('error', (error: Error) => {
          clearTimeout(connectionTimeout);
          this.isConnecting = false;
          
          // Update status
          const status = this.providerStatus.get(priority);
          if (status) {
            status.errorCount++;
            status.lastError = error.message;
          }
          
          this.metrics.failedConnections++;
          logger.error({ error: error.message }, 'WebSocket RPC error');
        });

        this.activeWsProvider.on('pong', () => {
          logger.debug('Received pong');
        });

      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Handle WebSocket messages
   */
  private handleWebSocketMessage(data: WebSocket.RawData): void {
    const receiveTime = Date.now();
    this.lastEventTime = receiveTime;
    this.noEventAlertSent = false;

    try {
      const message = JSON.parse(data.toString());

      // Handle subscription confirmations
      if (message.id && message.result !== undefined) {
        logger.debug({ id: message.id, result: message.result }, 'RPC response');
        return;
      }

      // Handle subscription notifications (log events)
      if (message.method === 'eth_subscription' && message.params) {
        this.emit('log', message.params);
        
        // Update status
        if (this.activeProviderPriority !== null) {
          const status = this.providerStatus.get(this.activeProviderPriority);
          if (status) {
            status.requestCount++;
            status.lastSuccessfulRequest = receiveTime;
          }
        }
      }

      // Handle errors
      if (message.error) {
        logger.error({ error: message.error }, 'RPC error response');
      }

    } catch (error) {
      logger.error({ error, data: data.toString().slice(0, 200) }, 'Failed to parse message');
    }
  }

  /**
   * Subscribe to log events via WebSocket
   */
  async subscribeToLogs(filter: {
    address: string | string[];
    topics: (string | null)[];
  }): Promise<string> {
    if (!this.activeWsProvider || this.activeWsProvider.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const subscribeParams = {
      jsonrpc: '2.0',
      id: this.wsMessageId++,
      method: 'eth_subscribe',
      params: ['logs', filter],
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Subscription timeout'));
      }, 10000);

      const messageHandler = (data: WebSocket.RawData) => {
        try {
          const response = JSON.parse(data.toString());
          
          if (response.id === subscribeParams.id) {
            clearTimeout(timeout);
            this.activeWsProvider?.removeListener('message', messageHandler);
            
            if (response.error) {
              reject(new Error(`Subscription failed: ${response.error.message}`));
              return;
            }
            
            if (response.result) {
              this.wsSubscriptionId = response.result;
              logger.info({ subscriptionId: this.wsSubscriptionId }, 'Log subscription active');
              resolve(response.result);
            }
          }
        } catch {
          // Not our response, ignore
        }
      };

      this.activeWsProvider?.on('message', messageHandler);
      this.activeWsProvider?.send(JSON.stringify(subscribeParams));
    });
  }

  /**
   * Start heartbeat to keep WebSocket alive
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    this.heartbeatInterval = setInterval(() => {
      if (this.activeWsProvider?.readyState === WebSocket.OPEN) {
        // Send WebSocket ping
        this.activeWsProvider.ping();
        
        // Also send eth_blockNumber as a ping
        const pingRequest = {
          jsonrpc: '2.0',
          id: this.wsMessageId++,
          method: 'eth_blockNumber',
          params: [],
        };
        this.activeWsProvider.send(JSON.stringify(pingRequest));
        
        logger.debug('Heartbeat sent');
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.stopHealthMonitoring();
    
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.HEALTH_CHECK_INTERVAL);
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Perform health check
   */
  private performHealthCheck(): void {
    const now = Date.now();
    
    // Check for no events
    if (this.lastEventTime > 0) {
      const timeSinceLastEvent = now - this.lastEventTime;
      
      if (timeSinceLastEvent > this.NO_EVENT_ALERT_THRESHOLD && !this.noEventAlertSent) {
        const message = `No events received for ${Math.floor(timeSinceLastEvent / 1000)} seconds`;
        logger.warn({ timeSinceLastEvent }, message);
        this.emit('alert', message, 'warning');
        this.noEventAlertSent = true;
      }
    }

    // Calculate uptime percentage for the day
    const dayDuration = now - this.dailyUptimeCheckStart;
    if (dayDuration >= 86400000) { // 24 hours
      const uptimePercentage = (this.totalUptimeMs / dayDuration) * 100;
      
      if (uptimePercentage < this.UPTIME_ALERT_THRESHOLD) {
        const message = `Daily uptime dropped to ${uptimePercentage.toFixed(2)}%`;
        logger.warn({ uptimePercentage }, message);
        this.emit('alert', message, 'critical');
      }
      
      // Reset daily tracking
      this.dailyUptimeCheckStart = now;
      this.totalUptimeMs = 0;
      this.totalDowntimeMs = 0;
    }

    // Update current uptime if connected
    if (this.connectionStartTime > 0) {
      this.metrics.uptimeMs = this.totalUptimeMs + (now - this.connectionStartTime);
    }
    
    this.updateUptimePercentage();

    logger.debug({
      connected: this.isWebSocketConnected(),
      pollingMode: this.isHttpPollingMode,
      lastEventTime: this.lastEventTime,
      uptimePercentage: this.metrics.uptimePercentage.toFixed(2),
    }, 'Health check');
  }

  /**
   * Update uptime percentage
   */
  private updateUptimePercentage(): void {
    const totalTime = this.totalUptimeMs + this.totalDowntimeMs;
    if (totalTime > 0) {
      this.metrics.uptimePercentage = (this.totalUptimeMs / totalTime) * 100;
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts++;
    this.metrics.totalReconnects++;

    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      this.RECONNECT_MAX_DELAY
    );

    logger.info({ 
      attempt: this.reconnectAttempts, 
      delay,
      maxAttempts: this.maxReconnectAttempts,
    }, 'Scheduling reconnection');

    // Track downtime
    if (this.connectionStartTime === 0 && this.metrics.lastDisconnectionTime > 0) {
      const downtimeStart = this.metrics.lastDisconnectionTime;
      this.totalDowntimeMs += Date.now() - downtimeStart;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      
      // If we've exceeded max attempts, switch to HTTP polling
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        logger.warn('Max reconnect attempts reached, switching to HTTP polling mode');
        this.emit('degraded', 'Switched to HTTP polling mode after WebSocket failures');
        await this.startHttpPolling();
        
        // Start background reconnection attempts to WebSocket
        this.startBackgroundWsReconnect();
        return;
      }

      try {
        // Try to reconnect to current provider
        if (this.activeProviderPriority !== null) {
          await this.connectWebSocket(this.activeProviderPriority);
          return;
        }

        // Try providers in priority order
        for (const [priority, provider] of this.providers) {
          if (!provider.enabled || !provider.wsUrl) continue;
          
          try {
            await this.connectWebSocket(priority);
            return;
          } catch {
            logger.warn({ provider: provider.name }, 'Reconnection failed');
          }
        }

        // All failed, schedule another attempt
        this.scheduleReconnect();
      } catch (error) {
        logger.error({ error }, 'Reconnection failed');
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Start HTTP polling as fallback
   */
  private async startHttpPolling(): Promise<void> {
    if (this.isHttpPollingMode) {
      return;
    }

    this.isHttpPollingMode = true;
    this.emit('alert', 'Running in degraded HTTP polling mode', 'warning');

    // Initialize HTTP provider with priority order
    for (const [priority, provider] of this.providers) {
      if (!provider.enabled) continue;
      
      try {
        this.activeHttpProvider = new JsonRpcProvider(provider.httpUrl, {
          chainId: POLYGON_CHAIN_ID,
          name: 'polygon',
        });
        
        // Test connection
        await this.activeHttpProvider.getBlockNumber();
        
        this.activeProviderPriority = priority;
        
        const status = this.providerStatus.get(priority);
        if (status) {
          status.httpHealthy = true;
          status.lastSuccessfulRequest = Date.now();
        }

        logger.info({ provider: provider.name }, 'HTTP provider connected');
        break;
      } catch (error) {
        logger.warn({ 
          provider: provider.name, 
          error: (error as Error).message,
        }, 'Failed to connect to HTTP provider');
      }
    }

    if (!this.activeHttpProvider) {
      throw new Error('Failed to connect to any HTTP provider');
    }

    // Note: HTTP polling for logs is handled externally
    // This manager just provides the connection
    logger.info('HTTP polling mode started');
  }

  /**
   * Stop HTTP polling
   */
  private stopHttpPolling(): void {
    if (this.httpPollingInterval) {
      clearInterval(this.httpPollingInterval);
      this.httpPollingInterval = null;
    }
    this.isHttpPollingMode = false;
  }

  /**
   * Start background WebSocket reconnection attempts
   */
  private startBackgroundWsReconnect(): void {
    if (this.wsBackgroundReconnectTimer) {
      return;
    }

    this.wsBackgroundReconnectTimer = setInterval(async () => {
      if (!this.isHttpPollingMode) {
        this.stopBackgroundWsReconnect();
        return;
      }

      logger.info('Attempting background WebSocket reconnection');
      
      for (const [priority, provider] of this.providers) {
        if (!provider.enabled || !provider.wsUrl) continue;
        
        try {
          await this.connectWebSocket(priority);
          
          // Successfully reconnected
          this.stopBackgroundWsReconnect();
          this.stopHttpPolling();
          this.emit('restored', provider.name);
          logger.info({ provider: provider.name }, 'WebSocket connection restored');
          return;
        } catch {
          // Continue to next provider
        }
      }

      logger.debug('Background WebSocket reconnection failed, will retry');
    }, this.WS_RECONNECT_BACKGROUND_INTERVAL);
  }

  /**
   * Stop background WebSocket reconnection
   */
  private stopBackgroundWsReconnect(): void {
    if (this.wsBackgroundReconnectTimer) {
      clearInterval(this.wsBackgroundReconnectTimer);
      this.wsBackgroundReconnectTimer = null;
    }
  }

  /**
   * Get HTTP provider for RPC calls
   */
  getHttpProvider(): JsonRpcProvider {
    if (this.activeHttpProvider) {
      return this.activeHttpProvider;
    }

    // Create a new HTTP provider
    for (const [priority, provider] of this.providers) {
      if (!provider.enabled) continue;
      
      this.activeHttpProvider = new JsonRpcProvider(provider.httpUrl, {
        chainId: POLYGON_CHAIN_ID,
        name: 'polygon',
      });
      this.activeProviderPriority = priority;
      return this.activeHttpProvider;
    }

    throw new Error('No HTTP provider available');
  }

  /**
   * Make HTTP RPC call with failover
   */
  async callWithFailover<T>(method: string, params: unknown[]): Promise<T> {
    const errors: Error[] = [];

    for (const [priority, provider] of this.providers) {
      if (!provider.enabled) continue;
      
      try {
        const httpProvider = new JsonRpcProvider(provider.httpUrl, {
          chainId: POLYGON_CHAIN_ID,
          name: 'polygon',
        });
        
        const startTime = Date.now();
        const result = await httpProvider.send(method, params);
        const latency = Date.now() - startTime;

        // Update status
        const status = this.providerStatus.get(priority);
        if (status) {
          status.httpHealthy = true;
          status.latencyMs = latency;
          status.requestCount++;
          status.lastSuccessfulRequest = Date.now();
        }

        return result as T;
      } catch (error) {
        errors.push(error as Error);
        
        // Update status
        const status = this.providerStatus.get(priority);
        if (status) {
          status.errorCount++;
          status.lastError = (error as Error).message;
        }

        logger.warn({ 
          provider: provider.name, 
          error: (error as Error).message,
        }, 'RPC call failed, trying next provider');

        // Emit failover event if not the last provider
        const nextProvider = Array.from(this.providers.values())[priority + 1];
        if (nextProvider) {
          this.emit('failover', provider.name, nextProvider.name);
        }
      }
    }

    throw new Error(`All providers failed: ${errors.map(e => e.message).join(', ')}`);
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.stopHeartbeat();
    this.stopHealthMonitoring();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    this.wsSubscriptionId = null;
  }

  /**
   * Disconnect all providers
   */
  async disconnect(): Promise<void> {
    this.isManualClose = true;
    this.cleanup();
    this.stopHttpPolling();
    this.stopBackgroundWsReconnect();

    // Unsubscribe from WebSocket
    if (this.wsSubscriptionId && this.activeWsProvider?.readyState === WebSocket.OPEN) {
      const unsubscribe = {
        jsonrpc: '2.0',
        id: this.wsMessageId++,
        method: 'eth_unsubscribe',
        params: [this.wsSubscriptionId],
      };
      this.activeWsProvider.send(JSON.stringify(unsubscribe));
    }

    // Close WebSocket
    if (this.activeWsProvider) {
      this.activeWsProvider.close(1000, 'Manual disconnect');
      this.activeWsProvider = null;
    }

    this.activeHttpProvider = null;
    this.activeProviderPriority = null;

    logger.info('RPC provider manager disconnected');
  }

  /**
   * Check if WebSocket is connected
   */
  isWebSocketConnected(): boolean {
    return this.activeWsProvider?.readyState === WebSocket.OPEN;
  }

  /**
   * Check if in HTTP polling mode
   */
  isInPollingMode(): boolean {
    return this.isHttpPollingMode;
  }

  /**
   * Get active provider name
   */
  getActiveProviderName(): string | null {
    if (this.activeProviderPriority === null) return null;
    return this.providers.get(this.activeProviderPriority)?.name ?? null;
  }

  /**
   * Get all provider statuses
   */
  getProviderStatuses(): ProviderStatus[] {
    return Array.from(this.providerStatus.values());
  }

  /**
   * Get connection metrics
   */
  getMetrics(): ConnectionMetrics {
    return { ...this.metrics };
  }

  /**
   * Get subscription ID
   */
  getSubscriptionId(): string | null {
    return this.wsSubscriptionId;
  }

  /**
   * Send raw message to WebSocket
   */
  sendRaw(message: string): void {
    if (this.activeWsProvider?.readyState === WebSocket.OPEN) {
      this.activeWsProvider.send(message);
    }
  }
}

// Singleton instance
let managerInstance: RPCProviderManager | null = null;

export function getRPCProviderManager(): RPCProviderManager {
  if (!managerInstance) {
    managerInstance = new RPCProviderManager();
  }
  return managerInstance;
}

export default RPCProviderManager;
