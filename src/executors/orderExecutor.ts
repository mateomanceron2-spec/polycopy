import { ethers, Wallet } from 'ethers';
import crypto from 'crypto';
import config from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { getRPCService } from '../services/rpc.js';
import { getNonceManager } from '../utils/nonce.js';
import { getGasOptimizer } from '../utils/gas.js';
import { getClobAuthService, type ClobAuthService, type ApiCredentials } from '../services/clobAuth.js';
import type { CopyTradeSignal, SignedOrder, OrderPayload } from '../config/types.js';
import {
  POLYMARKET_CONTRACTS,
  EIP712_DOMAIN,
  ORDER_TYPES,
  ORDER_SIDE,
  SIGNATURE_TYPE,
  DEFAULT_FEE_RATE_BPS,
  DEFAULT_ORDER_EXPIRATION_SECONDS,
} from '../config/constants.js';

const logger = createChildLogger('OrderExecutor');

export class OrderExecutor {
  private wallet: Wallet;
  private rpcService = getRPCService();
  private gasOptimizer = getGasOptimizer();
  private nonceManager;
  private clobAuthService: ClobAuthService;
  private apiCredentials: ApiCredentials | null = null;
  private isInitialized = false;
  
  // Performance tracking
  private executionLatencies: number[] = [];
  private successCount = 0;
  private failCount = 0;
  private pendingSignals: Map<string, CopyTradeSignal> = new Map();

  constructor() {
    if (!config.wallet.privateKey) {
      throw new Error('Private key not configured');
    }

    // Create wallet from private key
    const provider = this.rpcService.getProvider();
    this.wallet = new Wallet(config.wallet.privateKey, provider);
    this.nonceManager = getNonceManager(this.wallet.address);
    this.clobAuthService = getClobAuthService(this.wallet);

    logger.info({ address: this.wallet.address }, 'Order executor created');;
  }

  /**
   * Initialize the executor
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Initialize nonce manager
    await this.nonceManager.initialize();

    // Start gas optimizer
    this.gasOptimizer.startAutoUpdate();

    // Initialize CLOB API credentials (auto-derive if not configured)
    try {
      this.apiCredentials = await this.clobAuthService.initialize();
      logger.info({ 
        apiKeyPrefix: this.apiCredentials.apiKey.slice(0, 8) + '...' 
      }, 'CLOB API credentials initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize CLOB API credentials');
      throw error;
    }

    // Verify USDC balance
    const balance = await this.checkUSDCBalance();
    logger.info({ usdcBalance: balance }, 'USDC balance checked');

    this.isInitialized = true;
    logger.info('Order executor initialized');
  }

  /**
   * Execute a copy trade signal
   */
  async executeSignal(signal: CopyTradeSignal): Promise<CopyTradeSignal> {
    const startTime = Date.now();
    
    logger.info({
      signalId: signal.id,
      market: signal.market,
      side: signal.side,
      size: signal.calculatedSize,
    }, 'Executing signal');

    // Mark as executing
    signal.status = 'EXECUTING';
    this.pendingSignals.set(signal.id, signal);

    try {
      // Build the order
      const order = await this.buildOrder(signal);

      // Sign the order
      const signedOrder = await this.signOrder(order);

      // Submit to Polymarket CLOB
      const result = await this.submitOrder(signedOrder);

      // Update signal
      signal.status = 'EXECUTED';
      signal.executedAt = Date.now();
      signal.executionLatency = signal.executedAt - signal.detectedAt;

      // Track metrics
      const executionTime = Date.now() - startTime;
      this.executionLatencies.push(executionTime);
      if (this.executionLatencies.length > 100) {
        this.executionLatencies.shift();
      }
      this.successCount++;

      logger.info({
        signalId: signal.id,
        executionTime,
        e2eLatency: signal.executionLatency,
        result,
      }, 'Signal executed successfully');

    } catch (error) {
      signal.status = 'FAILED';
      signal.error = (error as Error).message;
      this.failCount++;

      logger.error({
        signalId: signal.id,
        error: (error as Error).message,
      }, 'Signal execution failed');
    }

    this.pendingSignals.delete(signal.id);
    return signal;
  }

  /**
   * Build order from signal
   */
  private async buildOrder(signal: CopyTradeSignal): Promise<Omit<SignedOrder, 'signature'>> {
    // Generate unique salt
    const salt = this.generateSalt();

    // Calculate amounts
    // For Polymarket: makerAmount is what you're giving, takerAmount is what you're receiving
    const size = parseFloat(signal.calculatedSize);
    const price = parseFloat(signal.maxPrice);

    let makerAmount: string;
    let takerAmount: string;

    if (signal.side === 'BUY') {
      // Buying outcome tokens: give USDC, receive outcome tokens
      // makerAmount = USDC amount (price * size, in 6 decimals for USDC)
      // takerAmount = outcome tokens amount (size, in 6 decimals)
      makerAmount = Math.floor(price * size * 1e6).toString();
      takerAmount = Math.floor(size * 1e6).toString();
    } else {
      // Selling outcome tokens: give outcome tokens, receive USDC
      makerAmount = Math.floor(size * 1e6).toString();
      takerAmount = Math.floor(price * size * 1e6).toString();
    }

    // Calculate expiration
    const expiration = Math.floor(Date.now() / 1000) + DEFAULT_ORDER_EXPIRATION_SECONDS;

    // Get nonce
    const nonce = await this.nonceManager.getNextNonce();

    const order: Omit<SignedOrder, 'signature'> = {
      salt,
      maker: this.wallet.address,
      signer: this.wallet.address,
      taker: ethers.ZeroAddress, // Open order, anyone can take
      tokenId: signal.assetId,
      makerAmount,
      takerAmount,
      expiration: expiration.toString(),
      nonce: nonce.toString(),
      feeRateBps: DEFAULT_FEE_RATE_BPS,
      side: signal.side === 'BUY' ? ORDER_SIDE.BUY : ORDER_SIDE.SELL,
      signatureType: SIGNATURE_TYPE.EOA,
    };

    return order;
  }

  /**
   * Sign order using EIP-712
   */
  private async signOrder(order: Omit<SignedOrder, 'signature'>): Promise<SignedOrder> {
    const domain = {
      name: EIP712_DOMAIN.name,
      version: EIP712_DOMAIN.version,
      chainId: EIP712_DOMAIN.chainId,
      verifyingContract: EIP712_DOMAIN.verifyingContract,
    };

    // Create mutable copy of types for ethers
    const types = {
      Order: [...ORDER_TYPES.Order],
    };

    const value = {
      salt: order.salt,
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      expiration: order.expiration,
      nonce: order.nonce,
      feeRateBps: order.feeRateBps,
      side: order.side,
      signatureType: order.signatureType,
    };

    const signature = await this.wallet.signTypedData(domain, types, value);

    return {
      ...order,
      signature,
    };
  }

  /**
   * Submit signed order to Polymarket CLOB API
   */
  private async submitOrder(order: SignedOrder): Promise<{ orderId: string }> {
    const payload: OrderPayload = {
      order,
      owner: this.wallet.address,
      orderType: 'FOK', // Fill or Kill for immediate execution
    };

    const url = `${config.polymarket.restUrl}/orders`;
    const body = JSON.stringify(payload);
    
    // Generate API authentication headers using ClobAuthService
    const headers = await this.clobAuthService.getL2Headers('POST', '/orders', body);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Order submission failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { orderID: string };
    return { orderId: result.orderID };
  }

  /**
   * Generate unique salt for order
   */
  private generateSalt(): string {
    const randomBytes = crypto.randomBytes(32);
    return BigInt('0x' + randomBytes.toString('hex')).toString();
  }

  /**
   * Check USDC balance
   */
  async checkUSDCBalance(): Promise<string> {
    const usdcContract = new ethers.Contract(
      POLYMARKET_CONTRACTS.USDC,
      ['function balanceOf(address) view returns (uint256)'],
      this.rpcService.getProvider()
    );

    const balance = await usdcContract.balanceOf(this.wallet.address);
    return ethers.formatUnits(balance, 6);
  }

  /**
   * Check native token (MATIC) balance
   */
  async checkNativeBalance(): Promise<string> {
    const balance = await this.rpcService.getBalance(this.wallet.address);
    return ethers.formatEther(balance);
  }

  /**
   * Approve USDC spending for Polymarket contracts
   */
  async approveUSDC(amount?: bigint): Promise<string> {
    const gasEstimate = await this.gasOptimizer.getAggressiveGasEstimate();
    const nonce = await this.nonceManager.getNextNonce();

    const usdcContract = new ethers.Contract(
      POLYMARKET_CONTRACTS.USDC,
      ['function approve(address spender, uint256 amount) returns (bool)'],
      this.wallet
    );

    const approveAmount = amount || ethers.MaxUint256;

    try {
      const tx = await usdcContract.approve(
        POLYMARKET_CONTRACTS.CTF_EXCHANGE,
        approveAmount,
        {
          nonce,
          maxFeePerGas: gasEstimate.maxFeePerGas,
          maxPriorityFeePerGas: gasEstimate.maxPriorityFeePerGas,
        }
      );

      const receipt = await tx.wait();
      await this.nonceManager.confirmNonce(nonce);

      logger.info({ txHash: receipt.hash }, 'USDC approval successful');
      return receipt.hash;
    } catch (error) {
      this.nonceManager.releaseNonce(nonce);
      throw error;
    }
  }

  /**
   * Get executor metrics
   */
  getMetrics(): {
    avgExecutionLatency: number;
    minExecutionLatency: number;
    maxExecutionLatency: number;
    successCount: number;
    failCount: number;
    successRate: number;
    pendingCount: number;
  } {
    const latencies = this.executionLatencies;
    const total = this.successCount + this.failCount;

    return {
      avgExecutionLatency: latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0,
      minExecutionLatency: latencies.length > 0
        ? Math.min(...latencies)
        : 0,
      maxExecutionLatency: latencies.length > 0
        ? Math.max(...latencies)
        : 0,
      successCount: this.successCount,
      failCount: this.failCount,
      successRate: total > 0 ? (this.successCount / total) * 100 : 0,
      pendingCount: this.pendingSignals.size,
    };
  }

  /**
   * Get wallet address
   */
  getWalletAddress(): string {
    return this.wallet.address;
  }

  /**
   * Shutdown executor
   */
  shutdown(): void {
    this.gasOptimizer.stopAutoUpdate();
    logger.info('Order executor shutdown');
  }
}

// Singleton instance
let orderExecutorInstance: OrderExecutor | null = null;

export function getOrderExecutor(): OrderExecutor {
  if (!orderExecutorInstance) {
    orderExecutorInstance = new OrderExecutor();
  }
  return orderExecutorInstance;
}

export default OrderExecutor;
