/**
 * Health Monitoring Service
 * 
 * Comprehensive health monitoring for all bot components:
 * - WebSocket connection status
 * - RPC provider health
 * - Event reception tracking
 * - Latency measurements
 * - Uptime calculations
 * - Error rate monitoring
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import { getAlertService, AlertService } from './alertService.js';
import { getDatabaseService, DatabaseService } from './database.js';
import type { HealthStatus } from '../config/types.js';

const logger = createChildLogger('HealthMonitor');

export interface ComponentHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  lastCheck: number;
  lastSuccess: number;
  errorCount: number;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

export interface LatencyMetrics {
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  samples: number;
}

export interface UptimeMetrics {
  componentName: string;
  uptimeMs: number;
  downtimeMs: number;
  uptimePercentage: number;
  totalOutages: number;
  longestOutageMs: number;
  lastOutageStart?: number;
  lastOutageEnd?: number;
}

export interface EventMetrics {
  totalReceived: number;
  targetEventsDetected: number;
  lastEventTime: number;
  eventsPerMinute: number;
  eventLatencies: LatencyMetrics;
}

export interface HealthReport {
  timestamp: number;
  overallStatus: 'healthy' | 'degraded' | 'critical';
  components: Map<string, ComponentHealth>;
  uptime: Map<string, UptimeMetrics>;
  latency: Map<string, LatencyMetrics>;
  events: EventMetrics;
  alerts: {
    active: number;
    recent24h: number;
  };
}

export class HealthMonitorService extends EventEmitter {
  private alertService: AlertService;
  private databaseService: DatabaseService | null = null;
  
  // Component tracking
  private components: Map<string, ComponentHealth> = new Map();
  private uptimeTracking: Map<string, {
    connectionStart: number;
    totalUptime: number;
    totalDowntime: number;
    outageStart: number;
    outageCount: number;
    longestOutage: number;
  }> = new Map();
  
  // Latency tracking
  private latencyBuffers: Map<string, number[]> = new Map();
  private readonly MAX_LATENCY_SAMPLES = 1000;
  
  // Event tracking
  private eventMetrics: EventMetrics = {
    totalReceived: 0,
    targetEventsDetected: 0,
    lastEventTime: 0,
    eventsPerMinute: 0,
    eventLatencies: this.createEmptyLatencyMetrics(),
  };
  private recentEventTimes: number[] = [];
  
  // Health check intervals
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private persistInterval: NodeJS.Timeout | null = null;
  
  // Configuration
  private readonly HEALTH_CHECK_INTERVAL = 10000; // 10 seconds
  private readonly PERSIST_INTERVAL = 60000; // 1 minute
  private readonly NO_EVENT_WARNING_THRESHOLD = 60000; // 60 seconds
  private readonly NO_EVENT_CRITICAL_THRESHOLD = 120000; // 120 seconds
  private readonly DAILY_UPTIME_THRESHOLD = 95; // 95%
  private readonly ERROR_RATE_THRESHOLD = 0.1; // 10% error rate

  constructor() {
    super();
    this.setMaxListeners(50);
    this.alertService = getAlertService();
  }

  /**
   * Start health monitoring
   */
  start(): void {
    logger.info('Starting health monitor');
    
    try {
      this.databaseService = getDatabaseService();
    } catch {
      logger.warn('Database service not available for health persistence');
    }

    // Start periodic health checks
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.HEALTH_CHECK_INTERVAL);

    // Start periodic persistence
    this.persistInterval = setInterval(() => {
      this.persistHealthReport();
    }, this.PERSIST_INTERVAL);

    // Initial health check
    this.performHealthCheck();
  }

  /**
   * Stop health monitoring
   */
  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.persistInterval) {
      clearInterval(this.persistInterval);
      this.persistInterval = null;
    }
    logger.info('Health monitor stopped');
  }

  /**
   * Register a component for health monitoring
   */
  registerComponent(name: string): void {
    if (!this.components.has(name)) {
      this.components.set(name, {
        name,
        status: 'down',
        lastCheck: 0,
        lastSuccess: 0,
        errorCount: 0,
        latencyMs: 0,
      });
      
      this.uptimeTracking.set(name, {
        connectionStart: 0,
        totalUptime: 0,
        totalDowntime: 0,
        outageStart: 0,
        outageCount: 0,
        longestOutage: 0,
      });
      
      this.latencyBuffers.set(name, []);
      
      logger.debug({ component: name }, 'Component registered');
    }
  }

  /**
   * Update component health status
   */
  updateComponentStatus(
    name: string,
    status: 'healthy' | 'degraded' | 'down',
    latencyMs?: number,
    metadata?: Record<string, unknown>
  ): void {
    const component = this.components.get(name);
    if (!component) {
      this.registerComponent(name);
      return this.updateComponentStatus(name, status, latencyMs, metadata);
    }

    const now = Date.now();
    const previousStatus = component.status;

    component.status = status;
    component.lastCheck = now;
    
    if (status === 'healthy') {
      component.lastSuccess = now;
    } else {
      component.errorCount++;
    }
    
    if (latencyMs !== undefined) {
      component.latencyMs = latencyMs;
      this.recordLatency(name, latencyMs);
    }
    
    if (metadata) {
      component.metadata = { ...component.metadata, ...metadata };
    }

    // Track uptime
    this.updateUptimeTracking(name, status, now);

    // Emit status change event
    if (previousStatus !== status) {
      this.emit('statusChange', { name, previousStatus, newStatus: status });
      
      if (status === 'down' && previousStatus !== 'down') {
        this.alertService.alertConnectionFailure(name, 'Component went down');
      } else if (status === 'healthy' && previousStatus === 'down') {
        this.alertService.alertConnectionRestored(name);
      }
    }
  }

  /**
   * Update uptime tracking
   */
  private updateUptimeTracking(
    name: string,
    status: 'healthy' | 'degraded' | 'down',
    timestamp: number
  ): void {
    const tracking = this.uptimeTracking.get(name);
    if (!tracking) return;

    const isUp = status === 'healthy' || status === 'degraded';

    if (isUp && tracking.connectionStart === 0) {
      // Connection started
      tracking.connectionStart = timestamp;
      
      // End any ongoing outage
      if (tracking.outageStart > 0) {
        const outageDuration = timestamp - tracking.outageStart;
        tracking.totalDowntime += outageDuration;
        tracking.longestOutage = Math.max(tracking.longestOutage, outageDuration);
        tracking.outageStart = 0;
      }
    } else if (!isUp && tracking.connectionStart > 0) {
      // Connection lost
      tracking.totalUptime += timestamp - tracking.connectionStart;
      tracking.connectionStart = 0;
      tracking.outageStart = timestamp;
      tracking.outageCount++;
    }
  }

  /**
   * Record latency sample
   */
  recordLatency(name: string, latencyMs: number): void {
    let buffer = this.latencyBuffers.get(name);
    if (!buffer) {
      buffer = [];
      this.latencyBuffers.set(name, buffer);
    }

    buffer.push(latencyMs);
    
    // Trim buffer if too large
    if (buffer.length > this.MAX_LATENCY_SAMPLES) {
      buffer.shift();
    }
  }

  /**
   * Calculate latency metrics from buffer
   */
  calculateLatencyMetrics(buffer: number[]): LatencyMetrics {
    if (buffer.length === 0) {
      return this.createEmptyLatencyMetrics();
    }

    const sorted = [...buffer].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      avg: sum / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: this.percentile(sorted, 50),
      p95: this.percentile(sorted, 95),
      p99: this.percentile(sorted, 99),
      samples: sorted.length,
    };
  }

  /**
   * Calculate percentile
   */
  private percentile(sortedArray: number[], p: number): number {
    const index = Math.ceil((p / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, index)];
  }

  /**
   * Create empty latency metrics
   */
  private createEmptyLatencyMetrics(): LatencyMetrics {
    return { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, samples: 0 };
  }

  /**
   * Record event received
   */
  recordEvent(latencyMs: number, isTargetEvent: boolean = false): void {
    const now = Date.now();
    
    this.eventMetrics.totalReceived++;
    this.eventMetrics.lastEventTime = now;
    
    if (isTargetEvent) {
      this.eventMetrics.targetEventsDetected++;
    }

    // Track recent events for rate calculation
    this.recentEventTimes.push(now);
    
    // Keep only last minute of events
    const oneMinuteAgo = now - 60000;
    this.recentEventTimes = this.recentEventTimes.filter(t => t > oneMinuteAgo);
    this.eventMetrics.eventsPerMinute = this.recentEventTimes.length;

    // Record latency
    this.recordLatency('events', latencyMs);
    
    // Update event latency metrics
    const eventBuffer = this.latencyBuffers.get('events') || [];
    this.eventMetrics.eventLatencies = this.calculateLatencyMetrics(eventBuffer);
  }

  /**
   * Perform health check
   */
  private performHealthCheck(): void {
    const now = Date.now();

    // Check event reception
    if (this.eventMetrics.lastEventTime > 0) {
      const timeSinceLastEvent = now - this.eventMetrics.lastEventTime;
      
      if (timeSinceLastEvent > this.NO_EVENT_CRITICAL_THRESHOLD) {
        this.alertService.alertNoEvents(Math.floor(timeSinceLastEvent / 1000));
      } else if (timeSinceLastEvent > this.NO_EVENT_WARNING_THRESHOLD) {
        logger.warn({ 
          timeSinceLastEvent,
        }, 'No events received recently');
      }
    }

    // Check daily uptime for each component
    for (const [, tracking] of this.uptimeTracking) {
      const totalTime = tracking.totalUptime + tracking.totalDowntime;
      if (totalTime > 0) {
        const uptimePercentage = (tracking.totalUptime / totalTime) * 100;
        
        if (uptimePercentage < this.DAILY_UPTIME_THRESHOLD) {
          this.alertService.alertUptimeDrop(uptimePercentage, this.DAILY_UPTIME_THRESHOLD);
        }
      }
    }

    // Check error rates
    for (const [name, component] of this.components) {
      const latencyBuffer = this.latencyBuffers.get(name) || [];
      if (latencyBuffer.length > 0 && component.errorCount > 0) {
        const errorRate = component.errorCount / (latencyBuffer.length + component.errorCount);
        
        if (errorRate > this.ERROR_RATE_THRESHOLD) {
          logger.warn({
            component: name,
            errorRate: (errorRate * 100).toFixed(2) + '%',
          }, 'High error rate detected');
        }
      }
    }

    // Emit health check event
    this.emit('healthCheck', this.getHealthReport());
  }

  /**
   * Get comprehensive health report
   */
  getHealthReport(): HealthReport {
    const now = Date.now();

    // Calculate uptime metrics
    const uptimeMetrics = new Map<string, UptimeMetrics>();
    for (const [name, tracking] of this.uptimeTracking) {
      let currentUptime = tracking.totalUptime;
      if (tracking.connectionStart > 0) {
        currentUptime += now - tracking.connectionStart;
      }
      
      let currentDowntime = tracking.totalDowntime;
      if (tracking.outageStart > 0) {
        currentDowntime += now - tracking.outageStart;
      }

      const totalTime = currentUptime + currentDowntime;
      
      uptimeMetrics.set(name, {
        componentName: name,
        uptimeMs: currentUptime,
        downtimeMs: currentDowntime,
        uptimePercentage: totalTime > 0 ? (currentUptime / totalTime) * 100 : 0,
        totalOutages: tracking.outageCount,
        longestOutageMs: tracking.longestOutage,
        lastOutageStart: tracking.outageStart > 0 ? tracking.outageStart : undefined,
      });
    }

    // Calculate latency metrics
    const latencyMetrics = new Map<string, LatencyMetrics>();
    for (const [name, buffer] of this.latencyBuffers) {
      latencyMetrics.set(name, this.calculateLatencyMetrics(buffer));
    }

    // Determine overall status
    let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
    for (const component of this.components.values()) {
      if (component.status === 'down') {
        overallStatus = 'critical';
        break;
      }
      if (component.status === 'degraded') {
        overallStatus = 'degraded';
      }
    }

    return {
      timestamp: now,
      overallStatus,
      components: new Map(this.components),
      uptime: uptimeMetrics,
      latency: latencyMetrics,
      events: { ...this.eventMetrics },
      alerts: {
        active: this.alertService.getUnacknowledgedAlerts().length,
        recent24h: this.alertService.getRecentAlerts(100).length,
      },
    };
  }

  /**
   * Get simple health status (for API/display)
   */
  getHealthStatus(): HealthStatus {
    const report = this.getHealthReport();
    
    const getStatus = (name: string): 'connected' | 'disconnected' | 'reconnecting' => {
      const component = report.components.get(name);
      if (!component) return 'disconnected';
      if (component.status === 'healthy') return 'connected';
      if (component.status === 'degraded') return 'reconnecting';
      return 'disconnected';
    };

    const getRpcStatus = (name: string): 'healthy' | 'degraded' | 'down' => {
      const component = report.components.get(name);
      return component?.status || 'down';
    };

    return {
      websocket: getStatus('WebSocket'),
      blockchainMonitor: getStatus('BlockchainMonitor'),
      primaryRpc: getRpcStatus('Infura'),
      failoverRpc: getRpcStatus('PolygonPublic'),
      redis: getStatus('Redis') === 'reconnecting' ? 'disconnected' : getStatus('Redis') as 'connected' | 'disconnected',
      mongodb: getStatus('MongoDB') === 'reconnecting' ? 'disconnected' : getStatus('MongoDB') as 'connected' | 'disconnected',
      lastHealthCheck: report.timestamp,
    };
  }

  /**
   * Persist health report to database
   */
  private async persistHealthReport(): Promise<void> {
    if (!this.databaseService) return;

    try {
      const report = this.getHealthReport();

      await this.databaseService.saveMetrics({
        tradeDetectionLatency: [report.events.eventLatencies.avg],
        orderExecutionLatency: [],
        endToEndLatency: [],
        successRate: 100,
        totalTradesCopied: 0,
        totalTradesFailed: 0,
        lastUpdate: report.timestamp,
      });

      logger.debug('Health report persisted');
    } catch (error) {
      logger.error({ error }, 'Failed to persist health report');
    }
  }

  /**
   * Reset metrics (for testing or daily reset)
   */
  resetMetrics(): void {
    for (const tracking of this.uptimeTracking.values()) {
      if (tracking.connectionStart > 0) {
        tracking.totalUptime = 0;
        tracking.connectionStart = Date.now();
      } else {
        tracking.totalUptime = 0;
        tracking.totalDowntime = 0;
      }
      tracking.outageCount = 0;
      tracking.longestOutage = 0;
    }

    for (const buffer of this.latencyBuffers.values()) {
      buffer.length = 0;
    }

    this.eventMetrics = {
      totalReceived: 0,
      targetEventsDetected: 0,
      lastEventTime: 0,
      eventsPerMinute: 0,
      eventLatencies: this.createEmptyLatencyMetrics(),
    };
    
    this.recentEventTimes = [];

    logger.info('Health metrics reset');
  }
}

// Singleton instance
let healthMonitorInstance: HealthMonitorService | null = null;

export function getHealthMonitor(): HealthMonitorService {
  if (!healthMonitorInstance) {
    healthMonitorInstance = new HealthMonitorService();
  }
  return healthMonitorInstance;
}

export default HealthMonitorService;
