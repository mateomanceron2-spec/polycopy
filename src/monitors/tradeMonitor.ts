import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { getBlockchainEventMonitor, BlockchainEventMonitor } from '../services/blockchainMonitor.js';
import type { Trade, CopyTradeSignal, OrderFilledEvent } from '../config/types.js';

const logger = createChildLogger('TradeMonitor');

// Polymarket Data API response types
interface PolymarketTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  outcome: string;
  transactionHash: string;
}

export interface TradeMonitorEvents {
  signal: (signal: CopyTradeSignal) => void;
  targetTrade: (trade: Trade) => void;
  error: (error: Error) => void;
}

/**
 * Trade Monitor using Polygon blockchain event monitoring
 * 
 * Advantages over API polling:
 * - 50-100ms detection latency (vs 150-300ms for REST)
 * - No rate limits (direct blockchain access)
 * - Most reliable (blockchain is source of truth)
 * - Real-time push via WebSocket subscription
 */
export class TradeMonitor extends EventEmitter {
  private blockchainMonitor: BlockchainEventMonitor;
  private targetAddress: string;
  private isRunning = false;
  
  // API polling mode
  private useApiPolling = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private readonly POLLING_INTERVAL_MS = 1000; // 1 second for ultra-low latency
  private lastSeenTimestamp = 0;
  
  // Deduplication
  private processedEvents: Set<string> = new Set();
  private readonly PROCESSED_EVENTS_MAX_SIZE = 10000;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL = 60000; // 1 minute
  
  // Performance metrics
  private detectionLatencies: number[] = [];
  private eventCount = 0;
  private signalCount = 0;
  private lastEventTime = 0;

  constructor() {
    super();
    // Use the first target address as primary (support for multiple is in blockchainMonitor)
    const targets = config.wallet.targetAddresses.filter(a => a && a.length > 0);
    this.targetAddress = targets.length > 0 ? targets[0].toLowerCase() : '';
    this.blockchainMonitor = getBlockchainEventMonitor(this.targetAddress);
    this.setMaxListeners(50);
  }

  /**
   * Start monitoring for target trader's activity via blockchain events
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Trade monitor already running');
      return;
    }

    if (!this.targetAddress || this.targetAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('Invalid target wallet address');
    }

    logger.info({ targetAddress: this.targetAddress }, 'Starting trade monitor');
    
    // Try WebSocket first, fall back to API polling
    try {
      // Set up blockchain event listeners
      this.setupBlockchainListeners();
      await this.blockchainMonitor.connect();
      logger.info('Using WebSocket mode for real-time trade detection');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'WebSocket connection failed, switching to API polling mode');
      this.useApiPolling = true;
    }

    // If WebSocket failed, start API polling
    if (this.useApiPolling) {
      logger.info('Starting Polymarket Data API polling mode');
      await this.startApiPolling();
    }

    // Start cleanup interval
    this.startCleanupInterval();

    this.isRunning = true;
    logger.info({
      mode: this.useApiPolling ? 'API Polling' : 'WebSocket',
      pollingInterval: this.useApiPolling ? `${this.POLLING_INTERVAL_MS}ms` : 'N/A',
    }, 'Trade monitor started');
  }

  /**
   * Start API polling for trades
   */
  private async startApiPolling(): Promise<void> {
    // Initialize last seen timestamp to 5 minutes ago (catch recent trades on startup)
    this.lastSeenTimestamp = Math.floor(Date.now() / 1000) - 300; // 5 minutes ago
    
    logger.info({ 
      lookbackSeconds: 300,
      startTime: new Date(this.lastSeenTimestamp * 1000).toISOString(),
    }, 'Starting API polling with 5-minute lookback');
    
    // Do initial fetch to warm up
    await this.pollForTrades();
    
    // Start polling interval
    this.pollingInterval = setInterval(async () => {
      try {
        await this.pollForTrades();
      } catch (error) {
        logger.error({ error }, 'Error polling for trades');
      }
    }, this.POLLING_INTERVAL_MS);
  }

  /**
   * Poll Polymarket Data API for new trades
   */
  private async pollForTrades(): Promise<void> {
    try {
      // Build URL with 'after' parameter to only get new activities
      const url = this.lastSeenTimestamp > 0
        ? `https://data-api.polymarket.com/activity?user=${this.targetAddress}&limit=10&after=${this.lastSeenTimestamp}`
        : `https://data-api.polymarket.com/activity?user=${this.targetAddress}&limit=10&after=${Math.floor(Date.now() / 1000) - 300}`;
      
      const response = await fetch(url, { headers: { 'Accept': 'application/json' } });

      if (!response.ok) return; // Silently fail to reduce overhead

      const data = await response.json() as any[];
      
      if (!data?.length) return;

      // Process newest first (data already in reverse chronological order from API)
      let newTradesFound = 0;
      let newestTimestamp = this.lastSeenTimestamp;
      
      for (let i = 0; i < data.length; i++) {
        const trade = data[i];
        const txHash = trade.transactionHash;
        
        // Fast deduplication check
        if (this.processedEvents.has(txHash)) continue;

        newTradesFound++;
        this.processedEvents.add(txHash);
        
        // Track newest timestamp
        if (trade.timestamp > newestTimestamp) {
          newestTimestamp = trade.timestamp;
        }

        // Process immediately for minimum latency
        this.handleApiTrade(trade);
      }
      
      // Update timestamp once after all trades processed
      if (newestTimestamp > this.lastSeenTimestamp) {
        this.lastSeenTimestamp = newestTimestamp;
      }
      
      // Maintain Set size (every 10 polls)
      if (newTradesFound > 0 && this.processedEvents.size > 500) {
        const toKeep = Array.from(this.processedEvents).slice(-250);
        this.processedEvents = new Set(toKeep);
      }
    } catch (error) {
      // Silent fail to minimize latency impact
    }
  }

  /**
   * Handle a trade from the API
   */
  private handleApiTrade(trade: any): void {
    const receiveTime = Date.now();
    this.eventCount++;
    this.lastEventTime = receiveTime;

    // Calculate detection latency
    const tradeTime = trade.timestamp * 1000;
    const detectionLatency = receiveTime - tradeTime;
    
    // Track latency (limit array size)
    if (this.detectionLatencies.length < 100) {
      this.detectionLatencies.push(detectionLatency);
    } else {
      this.detectionLatencies[this.eventCount % 100] = detectionLatency;
    }

    logger.info({
      txHash: trade.transactionHash.slice(0, 10),
      market: trade.title?.slice(0, 30),
      side: trade.side,
      size: trade.size,
      price: trade.price,
      latency: Math.floor(detectionLatency / 1000),
    }, '🎯 TRADE');

    // Convert to OrderFilledEvent format
    const event: OrderFilledEvent = {
      orderHash: trade.transactionHash,
      maker: this.targetAddress,
      taker: '',
      makerAssetId: trade.asset || '',
      takerAssetId: trade.asset || '',
      makerAmountFilled: String(Math.floor((trade.size || 0) * 1e6)),
      takerAmountFilled: String(Math.floor((trade.size || 0) * 1e6)),
      price: String(trade.price || 0),
      fee: '0',
      side: trade.side || 'BUY',
      tokenId: trade.asset || '',
      transactionHash: trade.transactionHash,
      blockNumber: 0,
      logIndex: 0,
      timestamp: tradeTime,
      usdcAmount: String(Math.floor((trade.size || 0) * (trade.price || 0) * 1e6)),
      tokenAmount: String(Math.floor((trade.size || 0) * 1e6)),
    };

    // Emit raw event for dry-run processing
    this.emit('rawEvent', event);

    // Convert to Trade format
    const tradeObj = this.convertApiTradeToTrade(trade);
    this.emit('targetTrade', tradeObj);

    // Generate signal
    this.generateSignalFromApiTrade(trade, receiveTime);
  }

  /**
   * Convert API trade to Trade format
   */
  private convertApiTradeToTrade(trade: PolymarketTrade): Trade {
    return {
      id: trade.transactionHash,
      taker_order_id: trade.transactionHash,
      market: trade.slug,
      asset_id: trade.asset,
      side: trade.side,
      size: trade.size.toString(),
      fee_rate_bps: '0',
      price: trade.price.toString(),
      status: 'MATCHED',
      match_time: new Date(trade.timestamp * 1000).toISOString(),
      last_update: new Date().toISOString(),
      outcome: trade.outcome,
      bucket_index: 0,
      owner: trade.proxyWallet,
      maker_address: trade.proxyWallet,
      transaction_hash: trade.transactionHash,
    };
  }

  /**
   * Generate signal from API trade
   */
  private generateSignalFromApiTrade(trade: PolymarketTrade, receiveTime: number): void {
    // Calculate position size
    const multiplier = config.trading.tradeMultiplier;
    const calculatedSize = trade.size * multiplier;

    // Calculate price with premium
    const pricePremium = config.trading.pricePremiumCents / 100;
    const maxPrice = trade.side === 'BUY'
      ? Math.min(trade.price + pricePremium, 0.99)
      : Math.max(trade.price - pricePremium, 0.01);

    const signal: CopyTradeSignal = {
      id: uuidv4(),
      targetTrade: this.convertApiTradeToTrade(trade),
      market: trade.title,
      assetId: trade.asset,
      side: trade.side,
      price: trade.price.toString(),
      originalSize: trade.size.toString(),
      calculatedSize: calculatedSize.toFixed(2),
      maxPrice: maxPrice.toFixed(4),
      detectedAt: receiveTime,
      status: 'PENDING',
    };

    this.signalCount++;
    logger.info({
      signalId: signal.id.slice(0, 8),
      market: trade.title.slice(0, 40),
      side: signal.side,
      size: signal.calculatedSize,
      price: signal.maxPrice,
    }, '📊 COPY SIGNAL GENERATED');

    this.emit('signal', signal);
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Stop API polling
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    // Remove listeners
    this.blockchainMonitor.removeAllListeners('orderFilled');
    this.blockchainMonitor.removeAllListeners('error');
    this.blockchainMonitor.removeAllListeners('healthAlert');
    
    // Disconnect blockchain monitor
    await this.blockchainMonitor.disconnect();
    
    // Stop cleanup
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.isRunning = false;
    logger.info('Trade monitor stopped');
  }

  /**
   * Set up blockchain event listeners
   */
  private setupBlockchainListeners(): void {
    // Handle OrderFilled events from blockchain
    this.blockchainMonitor.on('orderFilled', (event: OrderFilledEvent) => {
      this.handleOrderFilledEvent(event);
    });

    // Handle errors
    this.blockchainMonitor.on('error', (error: Error) => {
      logger.error({ error: error.message }, 'Blockchain monitor error');
      this.emit('error', error);
    });

    // Handle health alerts
    this.blockchainMonitor.on('healthAlert', (message: string) => {
      logger.warn({ alert: message }, 'Blockchain monitor health alert');
    });

    // Handle reconnection
    this.blockchainMonitor.on('connected', () => {
      logger.info('Blockchain monitor reconnected');
    });

    this.blockchainMonitor.on('disconnected', (reason: string) => {
      logger.warn({ reason }, 'Blockchain monitor disconnected');
    });
  }

  /**
   * Handle OrderFilled event from blockchain
   */
  private handleOrderFilledEvent(event: OrderFilledEvent): void {
    const receiveTime = Date.now();
    this.eventCount++;
    this.lastEventTime = receiveTime;

    // Create unique event ID for deduplication
    const eventId = `${event.transactionHash}-${event.logIndex}`;
    if (this.processedEvents.has(eventId)) {
      logger.debug({ eventId }, 'Duplicate event ignored');
      return;
    }
    this.processedEvents.add(eventId);
    this.maintainProcessedEventsSize();

    // Calculate detection latency (time from block to our processing)
    const detectionLatency = receiveTime - event.timestamp;
    this.detectionLatencies.push(detectionLatency);
    if (this.detectionLatencies.length > 100) {
      this.detectionLatencies.shift();
    }

    logger.info({
      txHash: event.transactionHash.slice(0, 18),
      block: event.blockNumber,
      side: event.side,
      tokenId: event.tokenId.slice(0, 16),
      price: event.price,
      amount: event.tokenAmount,
      latency: detectionLatency,
    }, 'Processing blockchain trade event');

    // Convert to Trade format for compatibility
    const trade = this.convertToTrade(event);
    this.emit('targetTrade', trade);

    // Generate copy trade signal
    this.generateSignal(event, receiveTime);
  }

  /**
   * Convert OrderFilledEvent to Trade format
   */
  private convertToTrade(event: OrderFilledEvent): Trade {
    return {
      id: `${event.transactionHash}-${event.logIndex}`,
      taker_order_id: event.orderHash,
      market: '', // Not available from event, will be resolved later
      asset_id: event.tokenId,
      side: event.side,
      size: event.tokenAmount,
      fee_rate_bps: '0',
      price: event.price,
      status: 'CONFIRMED',
      match_time: new Date(event.timestamp).toISOString(),
      last_update: new Date(event.timestamp).toISOString(),
      outcome: '', // Not available from event
      bucket_index: 0,
      owner: event.maker,
      maker_address: event.maker,
      transaction_hash: event.transactionHash,
      trader_side: 'MAKER',
    };
  }

  /**
   * Generate copy trade signal from blockchain event
   */
  private generateSignal(event: OrderFilledEvent, detectedAt: number): void {
    // Calculate position size
    // tokenAmount is in raw format (likely 6 decimals for Polymarket)
    const tokenAmountRaw = BigInt(event.tokenAmount);
    const usdcAmountRaw = BigInt(event.usdcAmount);
    
    // Convert to human-readable (assuming 6 decimals)
    const tokenAmount = Number(tokenAmountRaw) / 1e6;
    const usdcAmount = Number(usdcAmountRaw) / 1e6;
    
    // Calculate size based on copy ratio
    const calculatedSize = tokenAmount * config.trading.copyRatio;

    // Apply min/max constraints
    let finalSize = calculatedSize;
    if (finalSize < config.trading.minPositionSize) {
      logger.warn({
        tokenAmount,
        calculatedSize,
        minSize: config.trading.minPositionSize,
      }, 'Trade size below minimum, skipping');
      return;
    }
    if (finalSize > config.trading.maxPositionSize) {
      finalSize = config.trading.maxPositionSize;
      logger.warn({
        tokenAmount,
        calculatedSize,
        maxSize: config.trading.maxPositionSize,
        adjustedSize: finalSize,
      }, 'Trade size capped at maximum');
    }

    // Calculate price with slippage
    const price = parseFloat(event.price);
    const maxSlippage = config.trading.maxSlippage;
    const maxPrice = event.side === 'BUY'
      ? price * (1 + maxSlippage)
      : price * (1 - maxSlippage);

    // Create placeholder trade for signal
    const trade: Trade = this.convertToTrade(event);

    const signal: CopyTradeSignal = {
      id: uuidv4(),
      detectedAt,
      targetTrade: trade,
      market: '', // Will be resolved from tokenId
      assetId: event.tokenId,
      side: event.side,
      originalSize: tokenAmount.toFixed(6),
      calculatedSize: finalSize.toFixed(6),
      price: event.price,
      maxPrice: maxPrice.toFixed(4),
      status: 'PENDING',
    };

    this.signalCount++;

    logger.info({
      signalId: signal.id,
      txHash: event.transactionHash.slice(0, 18),
      side: signal.side,
      size: signal.calculatedSize,
      price: signal.price,
      maxPrice: signal.maxPrice,
      usdcAmount: usdcAmount.toFixed(2),
    }, 'Copy trade signal generated from blockchain event');

    this.emit('signal', signal);
  }

  /**
   * Start cleanup interval for old data
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.maintainProcessedEventsSize();
      
      logger.debug({
        processedSize: this.processedEvents.size,
        eventCount: this.eventCount,
        signalCount: this.signalCount,
      }, 'Trade monitor cleanup completed');
    }, this.CLEANUP_INTERVAL);
  }

  /**
   * Maintain processed events set size
   */
  private maintainProcessedEventsSize(): void {
    if (this.processedEvents.size > this.PROCESSED_EVENTS_MAX_SIZE) {
      const entries = Array.from(this.processedEvents);
      const toKeep = entries.slice(-this.PROCESSED_EVENTS_MAX_SIZE / 2);
      this.processedEvents.clear();
      toKeep.forEach(id => this.processedEvents.add(id));
    }
  }

  /**
   * Get performance metrics
   */
  getMetrics(): {
    avgDetectionLatency: number;
    minDetectionLatency: number;
    maxDetectionLatency: number;
    totalEventsProcessed: number;
    signalsGenerated: number;
    isRunning: boolean;
    blockchainStatus: string;
    lastEventTime: number;
    mode: string;
  } {
    const latencies = this.detectionLatencies;

    return {
      avgDetectionLatency: latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0,
      minDetectionLatency: latencies.length > 0
        ? Math.min(...latencies)
        : 0,
      maxDetectionLatency: latencies.length > 0
        ? Math.max(...latencies)
        : 0,
      totalEventsProcessed: this.eventCount,
      signalsGenerated: this.signalCount,
      isRunning: this.isRunning,
      blockchainStatus: this.useApiPolling ? 'API Polling' : this.blockchainMonitor.getConnectionStatus(),
      lastEventTime: this.lastEventTime,
      mode: this.useApiPolling ? 'API Polling (2s)' : 'WebSocket',
    };
  }

  /**
   * Check if monitor is running
   */
  isMonitorRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get blockchain monitor status
   */
  getBlockchainStatus() {
    return this.blockchainMonitor.getStatus();
  }

  /**
   * Inject a test signal (for dry-run mode testing)
   * This allows manual testing without WebSocket connection
   */
  injectTestSignal(signal: CopyTradeSignal): void {
    logger.info({ 
      market: signal.market || signal.assetId,
      side: signal.side,
      size: signal.calculatedSize,
    }, 'Injecting test signal for dry-run testing');
    
    this.signalCount++;
    this.emit('signal', signal);
  }
}

// Singleton instance
let tradeMonitorInstance: TradeMonitor | null = null;

export function getTradeMonitor(): TradeMonitor {
  if (!tradeMonitorInstance) {
    tradeMonitorInstance = new TradeMonitor();
  }
  return tradeMonitorInstance;
}

export default TradeMonitor;
