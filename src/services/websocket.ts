import WebSocket from 'ws';
import { EventEmitter } from 'events';
import config from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import type {
  WSMessage,
  WSSubscribeMessage,
  Trade,
  Order,
  LiveActivityEvent,
} from '../config/types.js';
import { WS_CHANNELS } from '../config/constants.js';

const logger = createChildLogger('WebSocketService');

export interface WebSocketEvents {
  connected: () => void;
  disconnected: (code: number, reason: string) => void;
  error: (error: Error) => void;
  trade: (trade: Trade) => void;
  order: (order: Order) => void;
  liveActivity: (event: LiveActivityEvent) => void;
  message: (message: WSMessage) => void;
}

export class WebSocketService extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private isManualClose = false;
  private subscribedChannels: Set<string> = new Set();
  private subscribedMarkets: Set<string> = new Set();
  private messageQueue: WSMessage[] = [];
  private connectionTime = 0;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Connect to Polymarket WebSocket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        logger.warn('WebSocket already connected');
        resolve();
        return;
      }

      this.isManualClose = false;
      const startTime = Date.now();

      try {
        this.ws = new WebSocket(config.polymarket.wsUrl, {
          headers: {
            'User-Agent': 'polymarket-copytrade-bot/1.0.0',
          },
          handshakeTimeout: 10000,
        });

        this.ws.on('open', () => {
          this.connectionTime = Date.now() - startTime;
          logger.info({ latency: this.connectionTime }, 'WebSocket connected');
          this.reconnectAttempts = 0;
          this.startPingInterval();
          this.flushMessageQueue();
          this.resubscribe();
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          const reasonStr = reason.toString();
          logger.warn({ code, reason: reasonStr }, 'WebSocket disconnected');
          this.cleanup();
          this.emit('disconnected', code, reasonStr);
          
          if (!this.isManualClose) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('error', (error: Error) => {
          logger.error({ error: error.message }, 'WebSocket error');
          this.emit('error', error);
          reject(error);
        });

        this.ws.on('ping', () => {
          this.ws?.pong();
        });

      } catch (error) {
        logger.error({ error }, 'Failed to create WebSocket connection');
        reject(error);
      }
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: WebSocket.RawData): void {
    const receiveTime = Date.now();
    
    try {
      const message = JSON.parse(data.toString()) as WSMessage;
      
      // Log latency if timestamp is available
      if (message.timestamp) {
        const messageTime = new Date(message.timestamp as string).getTime();
        const latency = receiveTime - messageTime;
        logger.debug({ latency, type: message.type }, 'Message received');
      }

      this.emit('message', message);

      // Route message to specific handlers
      switch (message.type) {
        case 'trade':
          if (message.data) {
            this.emit('trade', message.data as Trade);
          }
          break;
        case 'order':
          if (message.data) {
            this.emit('order', message.data as Order);
          }
          break;
        case 'live-activity':
          if (message.data) {
            this.emit('liveActivity', message.data as LiveActivityEvent);
          }
          break;
        case 'subscribed':
          logger.debug({ channel: message.channel }, 'Subscription confirmed');
          break;
        case 'error':
          logger.error({ message: message.message }, 'WebSocket error message');
          break;
        default:
          logger.debug({ type: message.type }, 'Unknown message type');
      }
    } catch (error) {
      logger.error({ error, data: data.toString().slice(0, 100) }, 'Failed to parse message');
    }
  }

  /**
   * Subscribe to market updates
   */
  subscribeToMarket(marketId: string): void {
    this.subscribedMarkets.add(marketId);
    const message: WSSubscribeMessage = {
      type: 'subscribe',
      channel: WS_CHANNELS.MARKET,
      markets: [marketId],
    };
    this.send(message);
  }

  /**
   * Subscribe to live activity feed (all trades on platform)
   */
  subscribeToLiveActivity(): void {
    this.subscribedChannels.add(WS_CHANNELS.LIVE_ACTIVITY);
    const message: WSSubscribeMessage = {
      type: 'subscribe',
      channel: WS_CHANNELS.LIVE_ACTIVITY,
    };
    this.send(message);
  }

  /**
   * Subscribe to user-specific updates
   */
  subscribeToUser(address: string): void {
    const channel = `${WS_CHANNELS.USER}:${address}`;
    this.subscribedChannels.add(channel);
    const message = {
      type: 'subscribe',
      channel: WS_CHANNELS.USER,
      user: address,
    };
    this.send(message);
  }

  /**
   * Send a message through WebSocket
   */
  private send(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      logger.debug({ type: message.type }, 'Message sent');
    } else {
      // Queue message for later
      this.messageQueue.push(message);
      logger.debug({ type: message.type }, 'Message queued (not connected)');
    }
  }

  /**
   * Flush queued messages after reconnection
   */
  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) {
        this.send(message);
      }
    }
  }

  /**
   * Resubscribe to channels after reconnection
   */
  private resubscribe(): void {
    // Resubscribe to markets
    for (const marketId of this.subscribedMarkets) {
      this.subscribeToMarket(marketId);
    }

    // Resubscribe to channels
    for (const channel of this.subscribedChannels) {
      if (channel === WS_CHANNELS.LIVE_ACTIVITY) {
        this.subscribeToLiveActivity();
      } else if (channel.startsWith(WS_CHANNELS.USER)) {
        const address = channel.split(':')[1];
        if (address) {
          this.subscribeToUser(address);
        }
      }
    }
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= config.performance.wsMaxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }

    const delay = Math.min(
      config.performance.wsReconnectDelay * Math.pow(2, this.reconnectAttempts),
      30000 // Max 30 seconds
    );

    logger.info({ attempt: this.reconnectAttempts + 1, delay }, 'Scheduling reconnection');

    this.reconnectTimer = setTimeout(async () => {
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
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Close WebSocket connection
   */
  async disconnect(): Promise<void> {
    this.isManualClose = true;
    this.cleanup();

    if (this.ws) {
      this.ws.close(1000, 'Manual disconnect');
      this.ws = null;
    }

    logger.info('WebSocket disconnected manually');
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection status
   */
  getStatus(): 'connected' | 'disconnected' | 'reconnecting' {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return 'connected';
    }
    if (this.reconnectTimer) {
      return 'reconnecting';
    }
    return 'disconnected';
  }

  /**
   * Get connection latency
   */
  getConnectionLatency(): number {
    return this.connectionTime;
  }
}

// Singleton instance
let wsServiceInstance: WebSocketService | null = null;

export function getWebSocketService(): WebSocketService {
  if (!wsServiceInstance) {
    wsServiceInstance = new WebSocketService();
  }
  return wsServiceInstance;
}

export default WebSocketService;
