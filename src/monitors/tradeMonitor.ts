import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { getBlockchainEventMonitor, BlockchainEventMonitor } from '../services/blockchainMonitor.js';
import type { Trade, CopyTradeSignal, OrderFilledEvent } from '../config/types.js';

const logger = createChildLogger('TradeMonitor');

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

    logger.info({ targetAddress: this.targetAddress }, 'Starting blockchain trade monitor');

    // Check if we're in dry-run mode - can skip WebSocket requirement
    const isDryRun = config.trading?.dryRunMode || process.env.DRY_RUN_MODE === 'true';
    
    // Set up blockchain event listeners
    this.setupBlockchainListeners();

    // Connect to blockchain WebSocket and subscribe to events
    try {
      await this.blockchainMonitor.connect();
    } catch (error: any) {
      if (isDryRun && error.message?.includes('No WebSocket RPC URL')) {
        logger.warn('No WebSocket RPC URL configured - running in dry-run simulation mode');
        logger.info('In dry-run mode, you can manually trigger test signals or the bot will simulate activity');
        // Continue without WebSocket in dry-run mode
      } else {
        throw error;
      }
    }

    // Start cleanup interval
    this.startCleanupInterval();

    this.isRunning = true;
    logger.info('Blockchain trade monitor started - monitoring OrderFilled events');
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
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
      blockchainStatus: this.blockchainMonitor.getConnectionStatus(),
      lastEventTime: this.lastEventTime,
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
