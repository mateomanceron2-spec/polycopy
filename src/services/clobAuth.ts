/**
 * CLOB Authentication Service
 * 
 * Handles automatic API credential generation for Polymarket CLOB API
 * using the official @polymarket/clob-client library for L1/L2 authentication.
 * 
 * Reference: https://docs.polymarket.com/developers/CLOB/authentication
 */

import { Wallet as EthersWallet } from 'ethers';
import { Wallet as EthersV5Wallet } from '@ethersproject/wallet';
import { ClobClient } from '@polymarket/clob-client';
import crypto from 'crypto';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';

const logger = createChildLogger('ClobAuth');

// CLOB API endpoints
const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

export interface ApiCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

export interface ClobAuthHeaders {
  'POLY_ADDRESS': string;
  'POLY_SIGNATURE': string;
  'POLY_TIMESTAMP': string;
  'POLY_NONCE': string;
  'POLY_API_KEY'?: string;
  'POLY_PASSPHRASE'?: string;
}

/**
 * Convert ethers v6 wallet to ethers v5 wallet for CLOB client compatibility
 * The @polymarket/clob-client uses ethers v5 internally
 */
function toEthersV5Wallet(wallet: EthersWallet): EthersV5Wallet {
  // Get the private key from ethers v6 wallet and create v5 wallet
  const privateKey = wallet.privateKey;
  return new EthersV5Wallet(privateKey);
}

/**
 * Generate L2 authentication headers (API key based)
 * Used for regular API operations (placing orders, etc.)
 */
export function generateL2Headers(
  credentials: ApiCredentials,
  walletAddress: string,
  method: string,
  path: string,
  body: string = ''
): ClobAuthHeaders {
  const timestamp = Date.now().toString();
  const nonce = Math.floor(Math.random() * 1000000).toString();
  
  // L2 signature: HMAC-SHA256 of timestamp + method + path + body
  const message = timestamp + method.toUpperCase() + path + body;
  const hmac = crypto.createHmac('sha256', credentials.apiSecret);
  hmac.update(message);
  const signature = hmac.digest('base64');
  
  return {
    'POLY_ADDRESS': walletAddress,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_NONCE': nonce,
    'POLY_API_KEY': credentials.apiKey,
    'POLY_PASSPHRASE': credentials.passphrase,
  };
}

/**
 * Derive API credentials from wallet using official CLOB client
 * This uses proper EIP-712 signing handled by the official library
 */
export async function deriveApiCredentials(wallet: EthersWallet): Promise<ApiCredentials> {
  logger.info({ address: wallet.address }, 'Deriving CLOB API credentials using official client...');
  
  try {
    // Convert to ethers v5 wallet for CLOB client compatibility
    const v5Wallet = toEthersV5Wallet(wallet);
    
    // Create CLOB client with L1 authentication (signer only, no API creds yet)
    const client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      v5Wallet  // Signer enables L1 methods
    );
    
    // Use official client to create or derive API key
    // This handles all the EIP-712 signing properly
    const apiCreds = await client.createOrDeriveApiKey();
    
    logger.info({ 
      apiKeyPrefix: apiCreds.key?.slice(0, 8) + '...',
    }, 'Successfully derived CLOB API credentials');
    
    return {
      apiKey: apiCreds.key,
      apiSecret: apiCreds.secret,
      passphrase: apiCreds.passphrase,
    };
    
  } catch (error) {
    logger.error({ error }, 'Failed to derive API credentials');
    throw error;
  }
}

/**
 * Create new API credentials using official CLOB client
 */
export async function createApiCredentials(wallet: EthersWallet): Promise<ApiCredentials> {
  logger.info({ address: wallet.address }, 'Creating new CLOB API credentials...');
  
  try {
    const v5Wallet = toEthersV5Wallet(wallet);
    
    const client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      v5Wallet
    );
    
    // Create new API credentials
    const apiCreds = await client.createApiKey();
    
    logger.info({ 
      apiKeyPrefix: apiCreds.key?.slice(0, 8) + '...',
    }, 'Successfully created new CLOB API credentials');
    
    return {
      apiKey: apiCreds.key,
      apiSecret: apiCreds.secret,
      passphrase: apiCreds.passphrase,
    };
    
  } catch (error) {
    logger.error({ error }, 'Failed to create API credentials');
    throw error;
  }
}

/**
 * Get or derive API credentials
 * Returns existing credentials from config or derives them from wallet
 */
export async function getOrDeriveApiCredentials(wallet: EthersWallet): Promise<ApiCredentials> {
  // Check if credentials are already configured
  const hasConfiguredCreds = 
    config.polymarket.apiKey && 
    config.polymarket.apiKey !== 'your_polymarket_api_key' &&
    config.polymarket.apiSecret &&
    config.polymarket.apiSecret !== 'your_polymarket_api_secret';
  
  if (hasConfiguredCreds) {
    logger.info('Using configured CLOB API credentials');
    return {
      apiKey: config.polymarket.apiKey,
      apiSecret: config.polymarket.apiSecret,
      passphrase: config.polymarket.passphrase,
    };
  }
  
  // Derive credentials from wallet
  logger.info('No API credentials configured, deriving from wallet...');
  return await deriveApiCredentials(wallet);
}

/**
 * Delete API credentials using official CLOB client
 */
export async function deleteApiCredentials(wallet: EthersWallet): Promise<void> {
  logger.info({ address: wallet.address }, 'Deleting CLOB API credentials...');
  
  try {
    const v5Wallet = toEthersV5Wallet(wallet);
    
    const client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      v5Wallet
    );
    
    await client.deleteApiKey();
    
    logger.info('Successfully deleted CLOB API credentials');
    
  } catch (error) {
    logger.error({ error }, 'Failed to delete API credentials');
    throw error;
  }
}

/**
 * Get list of all API keys for the wallet
 */
export async function listApiKeys(wallet: EthersWallet): Promise<any> {
  logger.info({ address: wallet.address }, 'Listing CLOB API keys...');
  
  try {
    const v5Wallet = toEthersV5Wallet(wallet);
    
    const client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      v5Wallet
    );
    
    const keysResponse = await client.getApiKeys();
    logger.info('Retrieved API keys');
    
    return keysResponse;
    
  } catch (error) {
    logger.error({ error }, 'Failed to list API credentials');
    throw error;
  }
}

/**
 * ClobAuthService - manages API credentials lifecycle
 */
export class ClobAuthService {
  private wallet: EthersWallet;
  private credentials: ApiCredentials | null = null;
  private isInitialized = false;
  private clobClient: ClobClient | null = null;
  
  constructor(wallet: EthersWallet) {
    this.wallet = wallet;
  }
  
  /**
   * Initialize and get/derive API credentials
   */
  async initialize(): Promise<ApiCredentials> {
    if (this.isInitialized && this.credentials) {
      return this.credentials;
    }
    
    this.credentials = await getOrDeriveApiCredentials(this.wallet);
    this.isInitialized = true;
    
    return this.credentials;
  }
  
  /**
   * Get current credentials (initialize if needed)
   */
  async getCredentials(): Promise<ApiCredentials> {
    if (!this.credentials) {
      return await this.initialize();
    }
    return this.credentials;
  }
  
  /**
   * Get the CLOB client with L2 authentication
   */
  async getClobClient(): Promise<ClobClient> {
    if (this.clobClient) {
      return this.clobClient;
    }
    
    const creds = await this.getCredentials();
    const v5Wallet = toEthersV5Wallet(this.wallet);
    
    this.clobClient = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      v5Wallet,
      {
        key: creds.apiKey,
        secret: creds.apiSecret,
        passphrase: creds.passphrase,
      }
    );
    
    return this.clobClient;
  }
  
  /**
   * Generate L2 headers for API requests
   */
  async getL2Headers(
    method: string,
    path: string,
    body: string = ''
  ): Promise<ClobAuthHeaders> {
    const creds = await this.getCredentials();
    return generateL2Headers(creds, this.wallet.address, method, path, body);
  }
  
  /**
   * Refresh credentials (derive new ones)
   */
  async refresh(): Promise<ApiCredentials> {
    this.credentials = await deriveApiCredentials(this.wallet);
    this.clobClient = null; // Reset client to use new credentials
    return this.credentials;
  }
  
  /**
   * Get wallet address
   */
  getWalletAddress(): string {
    return this.wallet.address;
  }
}

// Singleton instance
let instance: ClobAuthService | null = null;

export function getClobAuthService(wallet?: EthersWallet): ClobAuthService {
  if (!instance) {
    if (!wallet) {
      throw new Error('Wallet required for first initialization of ClobAuthService');
    }
    instance = new ClobAuthService(wallet);
  }
  return instance;
}

export default ClobAuthService;
