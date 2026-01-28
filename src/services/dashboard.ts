/**
 * Dashboard Service - Clean Terminal UI for Polymarket Copy Trade Bot
 */
import config from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import type { CopyTradeSignal } from '../config/types.js';

const logger = createChildLogger('Dashboard');

interface DashboardState {
  mode: 'DRY-RUN' | 'LIVE';
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  uptime: number;
  startTime: number;
  
  // Wallet info
  walletAddress: string;
  usdcBalance: string;
  maticBalance: string;
  
  // Target info
  targetAddresses: string[];
  
  // Trading stats
  tradesDetected: number;
  tradesExecuted: number;
  tradesFailed: number;
  successRate: number;
  
  // P&L (dry-run)
  totalPnL: number;
  unrealizedPnL: number;
  totalVolume: number;
  
  // Health
  rpcStatus: string;
  rpcProvider: string;
  redisStatus: string;
  mongoStatus: string;
  
  // Recent trades
  recentTrades: RecentTrade[];
  
  // Errors
  lastError: string | null;
  errorCount: number;
}

interface RecentTrade {
  id: string;
  time: string;
  market: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  status: 'SUCCESS' | 'FAILED' | 'SIMULATED';
  pnl?: string;
}

class DashboardService {
  private state: DashboardState;
  private refreshInterval: NodeJS.Timeout | null = null;
  private isEnabled = true;
  private lastRender = 0;
  private minRenderInterval = 1000; // Minimum 1 second between renders
  
  constructor() {
    this.state = {
      mode: (config.trading?.dryRunMode || process.env.DRY_RUN_MODE === 'true') ? 'DRY-RUN' : 'LIVE',
      status: 'STOPPED',
      uptime: 0,
      startTime: 0,
      walletAddress: '',
      usdcBalance: '0.00',
      maticBalance: '0.0000',
      targetAddresses: config.wallet.targetAddresses || [],
      tradesDetected: 0,
      tradesExecuted: 0,
      tradesFailed: 0,
      successRate: 0,
      totalPnL: 0,
      unrealizedPnL: 0,
      totalVolume: 0,
      rpcStatus: 'Connecting...',
      rpcProvider: 'None',
      redisStatus: 'Disconnected',
      mongoStatus: 'Disconnected',
      recentTrades: [],
      lastError: null,
      errorCount: 0,
    };
  }

  /**
   * Start the dashboard
   */
  start(walletAddress: string): void {
    this.state.walletAddress = walletAddress;
    this.state.startTime = Date.now();
    this.state.status = 'RUNNING';
    
    // Clear console and render initial dashboard
    this.render();
    
    // Refresh every 5 seconds
    this.refreshInterval = setInterval(() => {
      this.state.uptime = Date.now() - this.state.startTime;
      this.render();
    }, 5000);
    
    logger.info('Dashboard started');
  }

  /**
   * Stop the dashboard
   */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this.state.status = 'STOPPED';
    this.render();
  }

  /**
   * Update wallet balances
   */
  updateBalances(usdc: string, matic: string): void {
    this.state.usdcBalance = usdc;
    this.state.maticBalance = matic;
  }

  /**
   * Update RPC status
   */
  updateRpcStatus(status: string, provider: string): void {
    this.state.rpcStatus = status;
    this.state.rpcProvider = provider;
  }

  /**
   * Update health statuses
   */
  updateHealth(health: Partial<{ redis: string; mongo: string }>): void {
    if (health.redis) this.state.redisStatus = health.redis;
    if (health.mongo) this.state.mongoStatus = health.mongo;
  }

  /**
   * Record a detected trade
   */
  recordTradeDetected(): void {
    this.state.tradesDetected++;
  }

  /**
   * Record an executed trade
   */
  recordTradeExecuted(signal: CopyTradeSignal, simulated = false): void {
    if (signal.status === 'EXECUTED' || simulated) {
      this.state.tradesExecuted++;
    } else {
      this.state.tradesFailed++;
    }
    
    this.updateSuccessRate();
    
    // Add to recent trades
    const trade: RecentTrade = {
      id: signal.id.slice(0, 8),
      time: new Date().toLocaleTimeString('en-GB', { hour12: false }),
      market: this.truncateMarket(signal.market || signal.assetId),
      side: signal.side as 'BUY' | 'SELL',
      size: parseFloat(signal.calculatedSize).toFixed(2),
      price: parseFloat(signal.maxPrice).toFixed(4),
      status: simulated ? 'SIMULATED' : (signal.status === 'EXECUTED' ? 'SUCCESS' : 'FAILED'),
    };
    
    this.state.recentTrades.unshift(trade);
    if (this.state.recentTrades.length > 5) {
      this.state.recentTrades.pop();
    }
    
    // Trigger render
    this.render();
  }

  /**
   * Update P&L from dry-run service
   */
  updatePnL(realized: number, unrealized: number, volume: number): void {
    this.state.totalPnL = realized;
    this.state.unrealizedPnL = unrealized;
    this.state.totalVolume = volume;
  }

  /**
   * Record an error
   */
  recordError(error: string): void {
    this.state.lastError = error;
    this.state.errorCount++;
  }

  /**
   * Clear errors
   */
  clearErrors(): void {
    this.state.lastError = null;
    this.state.errorCount = 0;
  }

  /**
   * Update success rate
   */
  private updateSuccessRate(): void {
    const total = this.state.tradesExecuted + this.state.tradesFailed;
    this.state.successRate = total > 0 
      ? (this.state.tradesExecuted / total) * 100 
      : 100;
  }

  /**
   * Truncate market name for display
   */
  private truncateMarket(market: string): string {
    if (market.length > 25) {
      return market.slice(0, 22) + '...';
    }
    return market.padEnd(25);
  }

  /**
   * Format uptime
   */
  private formatUptime(): string {
    const seconds = Math.floor(this.state.uptime / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Format P&L with color indicator
   */
  private formatPnL(value: number): string {
    const formatted = value >= 0 ? `+$${value.toFixed(2)}` : `-$${Math.abs(value).toFixed(2)}`;
    return formatted;
  }

  /**
   * Render the dashboard
   */
  private render(): void {
    // Rate limit rendering
    const now = Date.now();
    if (now - this.lastRender < this.minRenderInterval) {
      return;
    }
    this.lastRender = now;

    if (!this.isEnabled) return;

    // Only clear console if we have data to show
    if (this.state.status === 'RUNNING') {
      console.clear();
    }

    const s = this.state;
    const modeIcon = s.mode === 'DRY-RUN' ? '🧪' : '💰';
    const statusIcon = s.status === 'RUNNING' ? '🟢' : (s.status === 'PAUSED' ? '🟡' : '🔴');

    // Build the dashboard
    const lines: string[] = [
      '',
      `╔══════════════════════════════════════════════════════════════════════════╗`,
      `║              POLYMARKET COPY TRADE BOT ${modeIcon}                               ║`,
      `╠══════════════════════════════════════════════════════════════════════════╣`,
      `║  Status: ${statusIcon} ${s.status.padEnd(10)}  │  Mode: ${s.mode.padEnd(8)}  │  Uptime: ${this.formatUptime()}       ║`,
      `╠══════════════════════════════════════════════════════════════════════════╣`,
      `║  WALLET                                                                  ║`,
      `║  Address: ${s.walletAddress.slice(0, 20)}...${s.walletAddress.slice(-8)}                              ║`,
      `║  USDC: $${s.usdcBalance.padEnd(12)} │  MATIC: ${s.maticBalance.padEnd(10)}                         ║`,
      `╠══════════════════════════════════════════════════════════════════════════╣`,
      `║  TARGETS                                                                 ║`,
    ];

    // Add target addresses
    for (const addr of s.targetAddresses.slice(0, 3)) {
      lines.push(`║  → ${addr.slice(0, 20)}...${addr.slice(-8)}                                         ║`);
    }
    if (s.targetAddresses.length > 3) {
      lines.push(`║    ... and ${s.targetAddresses.length - 3} more                                                  ║`);
    }

    lines.push(`╠══════════════════════════════════════════════════════════════════════════╣`);
    lines.push(`║  TRADING STATS                                                           ║`);
    lines.push(`║  Detected: ${s.tradesDetected.toString().padEnd(6)} │ Executed: ${s.tradesExecuted.toString().padEnd(6)} │ Failed: ${s.tradesFailed.toString().padEnd(6)} │ Rate: ${s.successRate.toFixed(1)}%  ║`);

    // P&L section (only for dry-run or if we have data)
    if (s.mode === 'DRY-RUN' || s.totalVolume > 0) {
      lines.push(`╠══════════════════════════════════════════════════════════════════════════╣`);
      lines.push(`║  P&L (${s.mode === 'DRY-RUN' ? 'Simulated' : 'Real'})                                                        ║`);
      
      const pnlStr = this.formatPnL(s.totalPnL);
      const unrealizedStr = this.formatPnL(s.unrealizedPnL);
      const totalPnL = s.totalPnL + s.unrealizedPnL;
      const totalStr = this.formatPnL(totalPnL);
      
      lines.push(`║  Realized: ${pnlStr.padEnd(12)} │ Unrealized: ${unrealizedStr.padEnd(12)} │ Total: ${totalStr.padEnd(10)} ║`);
      lines.push(`║  Volume: $${s.totalVolume.toFixed(2).padEnd(12)}                                             ║`);
    }

    // Health status
    lines.push(`╠══════════════════════════════════════════════════════════════════════════╣`);
    lines.push(`║  SYSTEM HEALTH                                                           ║`);
    
    const rpcIcon = s.rpcStatus === 'healthy' || s.rpcStatus === 'connected' ? '✅' : '⚠️';
    const redisIcon = s.redisStatus === 'Connected' || s.redisStatus === 'In-Memory' ? '✅' : '⚠️';
    const mongoIcon = s.mongoStatus === 'Connected' || s.mongoStatus === 'In-Memory' ? '✅' : '⚠️';
    
    lines.push(`║  RPC: ${rpcIcon} ${(s.rpcProvider || 'Unknown').padEnd(15)} │ Redis: ${redisIcon} ${s.redisStatus.padEnd(12)} │ DB: ${mongoIcon}        ║`);

    // Recent trades
    if (s.recentTrades.length > 0) {
      lines.push(`╠══════════════════════════════════════════════════════════════════════════╣`);
      lines.push(`║  RECENT TRADES                                                           ║`);
      lines.push(`║  Time     │ Market                    │ Side │ Size    │ Price  │ Status ║`);
      lines.push(`║───────────┼───────────────────────────┼──────┼─────────┼────────┼────────║`);
      
      for (const trade of s.recentTrades) {
        const sideStr = trade.side === 'BUY' ? '🟢BUY ' : '🔴SELL';
        const statusIcon = trade.status === 'SUCCESS' ? '✅' : (trade.status === 'SIMULATED' ? '🧪' : '❌');
        lines.push(`║  ${trade.time} │ ${trade.market.padEnd(25)} │ ${sideStr} │ ${trade.size.padEnd(7)} │ ${trade.price.padEnd(6)} │ ${statusIcon}     ║`);
      }
    }

    // Errors
    if (s.errorCount > 0 && s.lastError) {
      lines.push(`╠══════════════════════════════════════════════════════════════════════════╣`);
      lines.push(`║  ⚠️  LAST ERROR (${s.errorCount} total)                                               ║`);
      const errorMsg = s.lastError.length > 60 ? s.lastError.slice(0, 57) + '...' : s.lastError;
      lines.push(`║  ${errorMsg.padEnd(72)} ║`);
    }

    // Footer
    lines.push(`╠══════════════════════════════════════════════════════════════════════════╣`);
    lines.push(`║  Press Ctrl+C to stop  │  Logs: logs/app.log  │  ${new Date().toLocaleString('en-GB')}    ║`);
    lines.push(`╚══════════════════════════════════════════════════════════════════════════╝`);
    lines.push('');

    // Print all lines
    console.log(lines.join('\n'));
  }

  /**
   * Enable/disable dashboard
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    if (enabled) {
      this.render();
    }
  }

  /**
   * Get current state (for external access)
   */
  getState(): DashboardState {
    return { ...this.state };
  }

  /**
   * Print final summary (on shutdown)
   */
  printFinalSummary(): void {
    const s = this.state;
    console.log('\n');
    console.log('═'.repeat(70));
    console.log('  POLYMARKET COPY TRADE BOT - SESSION SUMMARY');
    console.log('═'.repeat(70));
    console.log(`  Mode:          ${s.mode}`);
    console.log(`  Runtime:       ${this.formatUptime()}`);
    console.log(`  Trades Detected: ${s.tradesDetected}`);
    console.log(`  Trades Executed: ${s.tradesExecuted}`);
    console.log(`  Trades Failed:   ${s.tradesFailed}`);
    console.log(`  Success Rate:    ${s.successRate.toFixed(1)}%`);
    if (s.mode === 'DRY-RUN') {
      console.log('  ─'.repeat(35));
      console.log(`  Simulated P&L:   ${this.formatPnL(s.totalPnL + s.unrealizedPnL)}`);
      console.log(`  Total Volume:    $${s.totalVolume.toFixed(2)}`);
    }
    console.log('═'.repeat(70));
    console.log('  Bot stopped successfully. Goodbye!');
    console.log('═'.repeat(70));
    console.log('\n');
  }
}

// Singleton instance
let dashboardInstance: DashboardService | null = null;

export function getDashboard(): DashboardService {
  if (!dashboardInstance) {
    dashboardInstance = new DashboardService();
  }
  return dashboardInstance;
}

export default DashboardService;
