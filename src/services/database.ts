import { MongoClient, Db, Collection, Document } from 'mongodb';
import config from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { MONGODB_COLLECTIONS } from '../config/constants.js';
import type { CopyTradeSignal, PerformanceMetrics } from '../config/types.js';

const logger = createChildLogger('DatabaseService');

// Daily stats interface (matches safetyLimits)
interface DailyStats {
  date: string;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalVolume: number;
  realizedPnL: number;
  unrealizedPnL: number;
  fees: number;
  startingBalance: number;
  currentBalance: number;
}

export class DatabaseService {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private isConnected = false;
  private useInMemoryFallback = false;
  private inMemoryTrades: CopyTradeSignal[] = [];
  private inMemoryMetrics: PerformanceMetrics[] = [];
  private inMemoryDailyStats: Map<string, DailyStats> = new Map();

  /**
   * Connect to MongoDB
   */
  async connect(): Promise<void> {
    try {
      this.client = new MongoClient(config.mongodb.uri, {
        maxPoolSize: 10,
        minPoolSize: 2,
        maxIdleTimeMS: 30000,
        serverSelectionTimeoutMS: 5000,
      });

      await this.client.connect();
      this.db = this.client.db(config.mongodb.database);

      // Create indexes for better query performance
      await this.createIndexes();

      this.isConnected = true;
      logger.info({ database: config.mongodb.database }, 'MongoDB connected');
    } catch (error) {
      logger.warn({ error }, 'MongoDB connection failed, using in-memory fallback (data will not persist)');
      this.useInMemoryFallback = true;
      this.isConnected = false;
    }
  }

  /**
   * Disconnect from MongoDB
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.isConnected = false;
      logger.info('MongoDB disconnected');
    }
  }

  /**
   * Create indexes for collections
   */
  private async createIndexes(): Promise<void> {
    if (!this.db) return;

    // Trades collection indexes
    const tradesCollection = this.db.collection(MONGODB_COLLECTIONS.TRADES);
    await tradesCollection.createIndex({ 'targetTrade.id': 1 }, { unique: true });
    await tradesCollection.createIndex({ detectedAt: -1 });
    await tradesCollection.createIndex({ status: 1 });
    await tradesCollection.createIndex({ market: 1 });

    // Metrics collection indexes
    const metricsCollection = this.db.collection(MONGODB_COLLECTIONS.METRICS);
    await metricsCollection.createIndex({ timestamp: -1 });

    // Errors collection indexes
    const errorsCollection = this.db.collection(MONGODB_COLLECTIONS.ERRORS);
    await errorsCollection.createIndex({ timestamp: -1 });
    await errorsCollection.createIndex({ type: 1 });

    logger.debug('MongoDB indexes created');
  }

  /**
   * Get a collection
   */
  private getCollection<T extends Document>(name: string): Collection<T> | null {
    if (!this.db || this.useInMemoryFallback) {
      return null;
    }
    return this.db.collection<T>(name);
  }

  // ================== Trade Operations ==================

  /**
   * Save a copy trade signal
   */
  async saveTrade(signal: CopyTradeSignal): Promise<void> {
    if (this.useInMemoryFallback) {
      this.inMemoryTrades.push(signal);
      if (this.inMemoryTrades.length > 1000) this.inMemoryTrades.shift();
      logger.debug({ signalId: signal.id }, 'Trade saved to in-memory store');
      return;
    }
    
    try {
      const collection = this.getCollection(MONGODB_COLLECTIONS.TRADES);
      if (!collection) return;
      await collection.updateOne(
        { 'targetTrade.id': signal.targetTrade.id },
        { $set: signal },
        { upsert: true }
      );
      logger.debug({ signalId: signal.id }, 'Trade saved to database');
    } catch (error) {
      logger.error({ error, signalId: signal.id }, 'Failed to save trade');
    }
  }

  /**
   * Get recent trades
   */
  async getRecentTrades(limit: number = 100): Promise<CopyTradeSignal[]> {
    if (this.useInMemoryFallback) {
      return this.inMemoryTrades.slice(-limit).reverse();
    }
    
    const collection = this.getCollection<CopyTradeSignal>(MONGODB_COLLECTIONS.TRADES);
    if (!collection) return [];
    return collection
      .find()
      .sort({ detectedAt: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Get trades by status
   */
  async getTradesByStatus(status: CopyTradeSignal['status']): Promise<CopyTradeSignal[]> {
    if (this.useInMemoryFallback) {
      return this.inMemoryTrades.filter(t => t.status === status);
    }
    
    const collection = this.getCollection<CopyTradeSignal>(MONGODB_COLLECTIONS.TRADES);
    if (!collection) return [];
    return collection.find({ status }).toArray();
  }

  /**
   * Get trade statistics
   */
  async getTradeStats(): Promise<{
    total: number;
    executed: number;
    failed: number;
    avgLatency: number;
  }> {
    if (this.useInMemoryFallback) {
      const executed = this.inMemoryTrades.filter(t => t.status === 'EXECUTED');
      const failed = this.inMemoryTrades.filter(t => t.status === 'FAILED');
      const avgLatency = executed.length > 0 
        ? executed.reduce((sum, t) => sum + (t.executionLatency || 0), 0) / executed.length 
        : 0;
      return {
        total: this.inMemoryTrades.length,
        executed: executed.length,
        failed: failed.length,
        avgLatency,
      };
    }
    
    const collection = this.getCollection(MONGODB_COLLECTIONS.TRADES);
    if (!collection) {
      return { total: 0, executed: 0, failed: 0, avgLatency: 0 };
    }
    
    const [total, executed, failed, latencyResult] = await Promise.all([
      collection.countDocuments(),
      collection.countDocuments({ status: 'EXECUTED' }),
      collection.countDocuments({ status: 'FAILED' }),
      collection.aggregate([
        { $match: { status: 'EXECUTED', executionLatency: { $exists: true } } },
        { $group: { _id: null, avgLatency: { $avg: '$executionLatency' } } },
      ]).toArray(),
    ]);

    return {
      total,
      executed,
      failed,
      avgLatency: latencyResult[0]?.avgLatency || 0,
    };
  }

  // ================== Metrics Operations ==================

  /**
   * Save performance metrics snapshot
   */
  async saveMetrics(metrics: PerformanceMetrics): Promise<void> {
    if (this.useInMemoryFallback) {
      this.inMemoryMetrics.push(metrics);
      if (this.inMemoryMetrics.length > 1000) this.inMemoryMetrics.shift();
      return;
    }
    
    try {
      const collection = this.getCollection(MONGODB_COLLECTIONS.METRICS);
      if (!collection) return;
      await collection.insertOne({
        ...metrics,
        timestamp: new Date(),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to save metrics');
    }
  }

  /**
   * Get historical metrics
   */
  async getMetricsHistory(hours: number = 24): Promise<PerformanceMetrics[]> {
    if (this.useInMemoryFallback) {
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      return this.inMemoryMetrics.filter(m => (m as any).timestamp?.getTime() > cutoff);
    }
    
    const collection = this.getCollection<PerformanceMetrics & { timestamp: Date }>(
      MONGODB_COLLECTIONS.METRICS
    );
    if (!collection) return [];
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return collection
      .find({ timestamp: { $gte: cutoff } })
      .sort({ timestamp: -1 })
      .toArray();
  }

  // ================== Error Logging ==================

  /**
   * Log an error
   */
  async logError(type: string, error: Error, context?: object): Promise<void> {
    if (this.useInMemoryFallback) {
      logger.error({ type, error: error.message, context }, 'Error (in-memory mode)');
      return;
    }
    
    try {
      const collection = this.getCollection(MONGODB_COLLECTIONS.ERRORS);
      if (!collection) return;
      await collection.insertOne({
        type,
        message: error.message,
        stack: error.stack,
        context,
        timestamp: new Date(),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to log error to database');
    }
  }

  /**
   * Get recent errors
   */
  async getRecentErrors(limit: number = 50): Promise<object[]> {
    if (this.useInMemoryFallback) return [];
    
    const collection = this.getCollection(MONGODB_COLLECTIONS.ERRORS);
    if (!collection) return [];
    return collection
      .find()
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  }

  // ================== Daily Stats Methods ==================

  /**
   * Get daily stats for a specific date
   */
  async getDailyStats(date: string): Promise<DailyStats | null> {
    if (this.useInMemoryFallback) {
      return this.inMemoryDailyStats.get(date) || null;
    }
    
    const collection = this.getCollection('daily_stats');
    if (!collection) return null;
    const result = await collection.findOne({ date });
    return result as DailyStats | null;
  }

  /**
   * Save or update daily stats
   */
  async saveDailyStats(stats: DailyStats): Promise<void> {
    if (this.useInMemoryFallback) {
      this.inMemoryDailyStats.set(stats.date, stats);
      return;
    }
    
    try {
      const collection = this.getCollection('daily_stats');
      if (!collection) return;
      await collection.updateOne(
        { date: stats.date },
        { $set: stats },
        { upsert: true }
      );
    } catch (error) {
      logger.error({ error }, 'Failed to save daily stats');
    }
  }

  /**
   * Get historical stats for the past N days
   */
  async getHistoricalStats(days: number): Promise<DailyStats[]> {
    if (this.useInMemoryFallback) {
      return Array.from(this.inMemoryDailyStats.values()).slice(-days);
    }
    
    const collection = this.getCollection('daily_stats');
    if (!collection) return [];
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
    
    const results = await collection
      .find({ date: { $gte: cutoffDateStr } })
      .sort({ date: -1 })
      .toArray();
    
    return results as unknown as DailyStats[];
  }

  // ================== Utility Methods ==================

  /**
   * Check if connected
   */
  isConnectedToDb(): boolean {
    return this.isConnected || this.useInMemoryFallback;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    if (!this.db) return false;
    try {
      await this.db.admin().ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get database stats
   */
  async getStats(): Promise<object> {
    if (!this.db) return {};
    try {
      return await this.db.stats();
    } catch {
      return {};
    }
  }
}

// Singleton instance
let databaseServiceInstance: DatabaseService | null = null;

export function getDatabaseService(): DatabaseService {
  if (!databaseServiceInstance) {
    databaseServiceInstance = new DatabaseService();
  }
  return databaseServiceInstance;
}

export default DatabaseService;
