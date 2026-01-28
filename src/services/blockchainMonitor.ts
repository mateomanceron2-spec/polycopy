import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import config from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import {
  POLYMARKET_CONTRACTS,
  EVENT_SIGNATURES,
  WS_RPC_CONFIG,
} from '../config/constants.js';
import type {
  RawEthLog,
  OrderFilledEvent,
  WSRPCSubscriptionResponse,
  WSRPCLogNotification,
  BlockchainMonitorStatus,
} from '../config/types.js';

const logger = createChildLogger('BlockchainMonitor');

export interface BlockchainMonitorEvents {
  connected: () => void;
  disconnected: (reason: string) => void;
  orderFilled: (event: OrderFilledEvent) => void;
  error: (error: Error) => void;
  healthAlert: (message: string) => void;
}

export class BlockchainEventMonitor extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscriptionId: string | null = null;
  private targetAddress: string;
  private isConnecting = false;
  private isManualClose = false;
  
  // Reconnection state
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  
  // Health monitoring
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastEventTime = 0;
  private lastBlockNumber = 0;
  private rpcMessageId = 1;
  
  // Metrics
  private eventsReceived = 0;
  private targetEventsDetected = 0;
  private connectionTime = 0;
  
  // Processed events deduplication
  private processedEvents: Set<string> = new Set();
  private readonly MAX_PROCESSED_EVENTS = 10000;

  constructor(targetAddress: string) {
    super();
    this.targetAddress = targetAddress.toLowerCase();
    this.setMaxListeners(50);
  }

  /**
   * Connect to WebSocket RPC and subscribe to events
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      logger.warn('Already connected');
      return;
    }

    if (this.isConnecting) {
      logger.warn('Connection already in progress');
      return;
    }

    this.isConnecting = true;
    this.isManualClose = false;
    const startTime = Date.now();

    // Build WebSocket URL
    const wsUrl = this.buildWebSocketUrl();
    if (!wsUrl) {
      this.isConnecting = false;
      throw new Error('No WebSocket RPC URL configured');
    }

    logger.info({ url: wsUrl.replace(/[a-f0-9]{32}/gi, '***') }, 'Connecting to WebSocket RPC');

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl, {
          handshakeTimeout: 10000,
        });

        const connectionTimeout = setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.ws?.close();
            reject(new Error('Connection timeout'));
          }
        }, 15000);

        this.ws.on('open', async () => {
          clearTimeout(connectionTimeout);
          this.connectionTime = Date.now() - startTime;
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          
          logger.info({ latency: this.connectionTime }, 'WebSocket RPC connected');

          try {
            // Subscribe to OrderFilled events
            await this.subscribeToEvents();
            
            // Start heartbeat
            this.startHeartbeat();
            
            // Start health monitoring
            this.startHealthMonitoring();
            
            this.emit('connected');
            resolve();
          } catch (error) {
            reject(error);
          }
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          clearTimeout(connectionTimeout);
          this.isConnecting = false;
          const reasonStr = reason.toString() || 'Unknown reason';
          
          logger.warn({ code, reason: reasonStr }, 'WebSocket RPC disconnected');
          this.cleanup();
          this.emit('disconnected', reasonStr);
          
          if (!this.isManualClose) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('error', (error: Error) => {
          clearTimeout(connectionTimeout);
          this.isConnecting = false;
          logger.error({ error: error.message }, 'WebSocket RPC error');
          this.emit('error', error);
        });

        this.ws.on('pong', () => {
          logger.debug('Received pong');
        });

      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Build WebSocket URL from config
   */
  private buildWebSocketUrl(): string | null {
    // Try Infura first
    if (config.rpc.infura.wsUrl && config.rpc.infura.projectId) {
      return `${config.rpc.infura.wsUrl}${config.rpc.infura.projectId}`;
    }
    
    // Fallback to QuickNode
    if (config.rpc.quicknode.wsUrl) {
      return config.rpc.quicknode.wsUrl;
    }

    return null;
  }

  /**
   * Subscribe to OrderFilled events on CTF Exchange contracts
   */
  private async subscribeToEvents(): Promise<void> {
    // Create filter for OrderFilled events
    // Filter by maker address (indexed parameter at position 1)
    const makerTopic = ethers.zeroPadValue(this.targetAddress, 32);

    const subscribeParams = {
      jsonrpc: '2.0',
      id: this.rpcMessageId++,
      method: 'eth_subscribe',
      params: [
        'logs',
        {
          address: [
            POLYMARKET_CONTRACTS.CTF_EXCHANGE,
            POLYMARKET_CONTRACTS.NEG_RISK_CTF_EXCHANGE,
          ],
          topics: [
            EVENT_SIGNATURES.ORDER_FILLED,
            null, // orderHash - any
            makerTopic, // maker - target wallet
          ],
        },
      ],
    };

    logger.info({
      contracts: [POLYMARKET_CONTRACTS.CTF_EXCHANGE, POLYMARKET_CONTRACTS.NEG_RISK_CTF_EXCHANGE],
      targetAddress: this.targetAddress,
    }, 'Subscribing to OrderFilled events');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Subscription timeout'));
      }, WS_RPC_CONFIG.SUBSCRIPTION_TIMEOUT);

      // Set up one-time handler for subscription response
      const messageHandler = (data: WebSocket.RawData) => {
        try {
          const response = JSON.parse(data.toString()) as WSRPCSubscriptionResponse;
          
          if (response.id === subscribeParams.id) {
            clearTimeout(timeout);
            this.ws?.removeListener('message', messageHandler);
            
            if (response.error) {
              reject(new Error(`Subscription failed: ${response.error.message}`));
              return;
            }
            
            if (response.result) {
              this.subscriptionId = response.result;
              logger.info({ subscriptionId: this.subscriptionId }, 'Event subscription active');
              resolve();
            }
          }
        } catch {
          // Not a subscription response, ignore
        }
      };

      this.ws?.on('message', messageHandler);
      this.ws?.send(JSON.stringify(subscribeParams));
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: WebSocket.RawData): void {
    const receiveTime = Date.now();

    try {
      const message = JSON.parse(data.toString());

      // Handle subscription notifications (events)
      if (message.method === 'eth_subscription' && message.params?.subscription === this.subscriptionId) {
        const notification = message as WSRPCLogNotification;
        this.handleLogEvent(notification.params.result, receiveTime);
        return;
      }

      // Handle other RPC responses (pings, etc.)
      if (message.id && message.result !== undefined) {
        logger.debug({ id: message.id }, 'RPC response received');
      }

    } catch (error) {
      logger.error({ error, data: data.toString().slice(0, 200) }, 'Failed to parse message');
    }
  }

  /**
   * Handle raw log event
   */
  private handleLogEvent(log: RawEthLog, receiveTime: number): void {
    this.eventsReceived++;
    this.lastEventTime = receiveTime;
    this.lastBlockNumber = parseInt(log.blockNumber, 16);

    // Create unique event ID for deduplication
    const eventId = `${log.transactionHash}-${log.logIndex}`;
    if (this.processedEvents.has(eventId)) {
      logger.debug({ eventId }, 'Duplicate event ignored');
      return;
    }
    this.processedEvents.add(eventId);
    this.maintainProcessedEventsSize();

    // Parse the event
    try {
      const parsedEvent = this.parseOrderFilledEvent(log, receiveTime);
      
      // Check if this is from our target (double-check)
      if (parsedEvent.maker.toLowerCase() !== this.targetAddress) {
        logger.debug({ maker: parsedEvent.maker }, 'Event not from target, ignoring');
        return;
      }

      this.targetEventsDetected++;

      logger.info({
        txHash: parsedEvent.transactionHash.slice(0, 18),
        block: parsedEvent.blockNumber,
        maker: parsedEvent.maker.slice(0, 10),
        side: parsedEvent.side,
        tokenId: parsedEvent.tokenId.slice(0, 10),
        price: parsedEvent.price,
        amount: parsedEvent.tokenAmount,
        latency: receiveTime - parsedEvent.timestamp,
      }, 'Target OrderFilled event detected');

      this.emit('orderFilled', parsedEvent);

    } catch (error) {
      logger.error({ error, log }, 'Failed to parse OrderFilled event');
    }
  }

  /**
   * Parse raw log into OrderFilledEvent
   */
  private parseOrderFilledEvent(log: RawEthLog, receiveTime: number): OrderFilledEvent {
    // Topics: [eventSig, orderHash, maker, taker]
    const orderHash = log.topics[1];
    const maker = ethers.getAddress('0x' + log.topics[2].slice(26));
    const taker = ethers.getAddress('0x' + log.topics[3].slice(26));

    // Decode data: makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const decoded = abiCoder.decode(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      log.data
    );

    const makerAssetId = decoded[0].toString();
    const takerAssetId = decoded[1].toString();
    const makerAmountFilled = decoded[2].toString();
    const takerAmountFilled = decoded[3].toString();
    const fee = decoded[4].toString();

    // Determine side: if maker is giving USDC (small asset ID), they're BUYING tokens
    // Polymarket uses large token IDs for outcome tokens
    // USDC amounts are typically in 6 decimals, tokens in higher precision
    const makerAssetIdNum = BigInt(makerAssetId);
    const takerAssetIdNum = BigInt(takerAssetId);
    
    // Heuristic: The asset with the smaller ID or zero-ish is typically USDC collateral
    // The larger ID is the conditional token
    let side: 'BUY' | 'SELL';
    let tokenId: string;
    let usdcAmount: string;
    let tokenAmount: string;

    // If makerAssetId is 0 or very small, maker is paying USDC = BUY
    // If takerAssetId is 0 or very small, maker is receiving USDC = SELL
    if (makerAssetIdNum === 0n || makerAssetIdNum < takerAssetIdNum) {
      side = 'BUY';
      tokenId = takerAssetId;
      usdcAmount = makerAmountFilled;
      tokenAmount = takerAmountFilled;
    } else {
      side = 'SELL';
      tokenId = makerAssetId;
      usdcAmount = takerAmountFilled;
      tokenAmount = makerAmountFilled;
    }

    // Calculate price (USDC per token)
    const usdcBigInt = BigInt(usdcAmount);
    const tokenBigInt = BigInt(tokenAmount);
    const price = tokenBigInt > 0n 
      ? (Number(usdcBigInt) / Number(tokenBigInt)).toFixed(4)
      : '0';

    return {
      transactionHash: log.transactionHash,
      blockNumber: parseInt(log.blockNumber, 16),
      logIndex: parseInt(log.logIndex, 16),
      timestamp: receiveTime, // We use receive time as we don't have block timestamp
      orderHash,
      maker,
      taker,
      makerAssetId,
      takerAssetId,
      makerAmountFilled,
      takerAmountFilled,
      fee,
      side,
      tokenId,
      usdcAmount,
      tokenAmount,
      price,
    };
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Send a ping
        this.ws.ping();
        
        // Also send an RPC call to verify connection
        const pingRequest = {
          jsonrpc: '2.0',
          id: this.rpcMessageId++,
          method: 'eth_blockNumber',
          params: [],
        };
        this.ws.send(JSON.stringify(pingRequest));
        
        logger.debug('Heartbeat sent');
      }
    }, WS_RPC_CONFIG.HEARTBEAT_INTERVAL);
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastEvent = now - this.lastEventTime;

      // Alert if no events for too long (but only after we've received at least one)
      if (this.lastEventTime > 0 && timeSinceLastEvent > WS_RPC_CONFIG.NO_EVENT_ALERT_THRESHOLD) {
        const message = `No events received for ${Math.floor(timeSinceLastEvent / 1000)}s`;
        logger.warn({ timeSinceLastEvent }, message);
        this.emit('healthAlert', message);
      }

      // Log status periodically
      logger.debug({
        subscriptionId: this.subscriptionId,
        eventsReceived: this.eventsReceived,
        targetEvents: this.targetEventsDetected,
        lastBlock: this.lastBlockNumber,
      }, 'Health check');

    }, 30000); // Every 30 seconds
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(
      WS_RPC_CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts),
      WS_RPC_CONFIG.RECONNECT_MAX_DELAY
    );

    logger.info({ attempt: this.reconnectAttempts + 1, delay }, 'Scheduling reconnection');

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      
      try {
        await this.connect();
      } catch (error) {
        logger.error({ error }, 'Reconnection failed');
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Maintain processed events set size
   */
  private maintainProcessedEventsSize(): void {
    if (this.processedEvents.size > this.MAX_PROCESSED_EVENTS) {
      const entries = Array.from(this.processedEvents);
      const toKeep = entries.slice(-this.MAX_PROCESSED_EVENTS / 2);
      this.processedEvents.clear();
      toKeep.forEach(id => this.processedEvents.add(id));
    }
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.subscriptionId = null;
  }

  /**
   * Disconnect from WebSocket
   */
  async disconnect(): Promise<void> {
    this.isManualClose = true;
    this.cleanup();

    if (this.ws) {
      // Unsubscribe first
      if (this.subscriptionId && this.ws.readyState === WebSocket.OPEN) {
        const unsubscribe = {
          jsonrpc: '2.0',
          id: this.rpcMessageId++,
          method: 'eth_unsubscribe',
          params: [this.subscriptionId],
        };
        this.ws.send(JSON.stringify(unsubscribe));
      }

      this.ws.close(1000, 'Manual disconnect');
      this.ws = null;
    }

    logger.info('Blockchain monitor disconnected');
  }

  /**
   * Get monitor status
   */
  getStatus(): BlockchainMonitorStatus {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      subscriptionId: this.subscriptionId,
      lastEventTime: this.lastEventTime,
      lastBlockNumber: this.lastBlockNumber,
      eventsReceived: this.eventsReceived,
      targetEventsDetected: this.targetEventsDetected,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.subscriptionId !== null;
  }

  /**
   * Get connection status string
   */
  getConnectionStatus(): 'connected' | 'disconnected' | 'reconnecting' {
    if (this.ws?.readyState === WebSocket.OPEN && this.subscriptionId) {
      return 'connected';
    }
    if (this.reconnectTimer || this.isConnecting) {
      return 'reconnecting';
    }
    return 'disconnected';
  }
}

// Factory function to create monitor instance
let monitorInstance: BlockchainEventMonitor | null = null;

export function getBlockchainEventMonitor(targetAddress?: string): BlockchainEventMonitor {
  if (!monitorInstance) {
    // Support for multiple targets - use first one as primary
    const targets = config.wallet.targetAddresses.filter(a => a && a.length > 0);
    const address = targetAddress || (targets.length > 0 ? targets[0] : '');
    if (!address) {
      throw new Error('Target address required for blockchain monitor');
    }
    monitorInstance = new BlockchainEventMonitor(address);
  }
  return monitorInstance;
}

export default BlockchainEventMonitor;
