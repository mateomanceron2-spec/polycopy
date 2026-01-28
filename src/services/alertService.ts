/**
 * Alert Notification Service
 * 
 * Handles sending alerts for:
 * - Connection failures
 * - Degraded mode activation
 * - No events received
 * - Uptime drops
 * - Error thresholds exceeded
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';

const logger = createChildLogger('AlertService');

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertType = 
  | 'connection_failure'
  | 'connection_restored'
  | 'degraded_mode'
  | 'no_events'
  | 'uptime_drop'
  | 'error_threshold'
  | 'trade_failure'
  | 'trade_success'
  | 'health_check'
  | 'kill_switch'
  | 'circuit_breaker'
  | 'daily_loss_limit'
  | 'balance_warning'
  | 'system_start'
  | 'system_stop';

export interface Alert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
  acknowledged: boolean;
}

export interface AlertConfig {
  // Enable/disable alert destinations
  enableConsole: boolean;
  enableWebhook: boolean;
  enableEmail: boolean;
  enableTelegram: boolean;
  enableDiscord: boolean;
  
  // Webhook configuration
  webhookUrl?: string;
  webhookSecret?: string;
  
  // Email configuration
  emailTo?: string;
  
  // Telegram configuration
  telegramBotToken?: string;
  telegramChatId?: string;
  
  // Discord configuration
  discordWebhookUrl?: string;
  
  // Alert throttling (prevent spam)
  throttleIntervalMs: number;
  maxAlertsPerInterval: number;
  
  // Quiet hours (optional)
  quietHoursStart?: number; // Hour in 24h format
  quietHoursEnd?: number;
  quietHoursSeverityThreshold?: AlertSeverity; // Only send alerts >= this severity during quiet hours
}

export class AlertService extends EventEmitter {
  private alerts: Map<string, Alert> = new Map();
  private alertHistory: Alert[] = [];
  private throttleCounters: Map<AlertType, { count: number; resetTime: number }> = new Map();
  private alertCounter = 0;
  
  private config: AlertConfig = {
    enableConsole: true,
    enableWebhook: false,
    enableEmail: false,
    enableTelegram: false,
    enableDiscord: false,
    throttleIntervalMs: 60000, // 1 minute
    maxAlertsPerInterval: 5,
  };

  constructor(alertConfig?: Partial<AlertConfig>) {
    super();
    this.setMaxListeners(50);
    
    if (alertConfig) {
      this.config = { ...this.config, ...alertConfig };
    }
    
    // Load from environment if available
    if (process.env.ALERT_WEBHOOK_URL) {
      this.config.webhookUrl = process.env.ALERT_WEBHOOK_URL;
      this.config.enableWebhook = true;
    }
    if (process.env.ALERT_EMAIL_TO) {
      this.config.emailTo = process.env.ALERT_EMAIL_TO;
      this.config.enableEmail = true;
    }
    
    // Telegram configuration
    if (config.alerts.telegramBotToken && config.alerts.telegramChatId) {
      this.config.telegramBotToken = config.alerts.telegramBotToken;
      this.config.telegramChatId = config.alerts.telegramChatId;
      this.config.enableTelegram = true;
    }
    
    // Discord configuration
    if (config.alerts.discordWebhookUrl) {
      this.config.discordWebhookUrl = config.alerts.discordWebhookUrl;
      this.config.enableDiscord = true;
    }
  }

  /**
   * Send an alert
   */
  async sendAlert(
    type: AlertType,
    severity: AlertSeverity,
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<Alert | null> {
    // Check throttling
    if (this.isThrottled(type)) {
      logger.debug({ type, message }, 'Alert throttled');
      return null;
    }

    // Check quiet hours
    if (this.isQuietHours() && !this.shouldSendDuringQuietHours(severity)) {
      logger.debug({ type, severity, message }, 'Alert suppressed during quiet hours');
      return null;
    }

    // Create alert
    const alert: Alert = {
      id: `alert_${++this.alertCounter}_${Date.now()}`,
      type,
      severity,
      message,
      timestamp: Date.now(),
      metadata,
      acknowledged: false,
    };

    // Store alert
    this.alerts.set(alert.id, alert);
    this.alertHistory.push(alert);
    this.trimAlertHistory();

    // Update throttle counter
    this.updateThrottleCounter(type);

    // Send to destinations
    await this.dispatchAlert(alert);

    // Emit event
    this.emit('alert', alert);

    return alert;
  }

  /**
   * Dispatch alert to configured destinations
   */
  private async dispatchAlert(alert: Alert): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.config.enableConsole) {
      promises.push(this.sendToConsole(alert));
    }

    if (this.config.enableWebhook && this.config.webhookUrl) {
      promises.push(this.sendToWebhook(alert));
    }

    if (this.config.enableEmail && this.config.emailTo) {
      promises.push(this.sendToEmail(alert));
    }
    
    if (this.config.enableTelegram && this.config.telegramBotToken && this.config.telegramChatId) {
      promises.push(this.sendToTelegram(alert));
    }
    
    if (this.config.enableDiscord && this.config.discordWebhookUrl) {
      promises.push(this.sendToDiscord(alert));
    }

    await Promise.allSettled(promises);
  }

  /**
   * Send alert to console/log
   */
  private async sendToConsole(alert: Alert): Promise<void> {
    const logData = {
      alertId: alert.id,
      type: alert.type,
      severity: alert.severity,
      ...alert.metadata,
    };

    switch (alert.severity) {
      case 'critical':
        logger.error(logData, `🚨 CRITICAL: ${alert.message}`);
        break;
      case 'warning':
        logger.warn(logData, `⚠️ WARNING: ${alert.message}`);
        break;
      case 'info':
        logger.info(logData, `ℹ️ INFO: ${alert.message}`);
        break;
    }
  }

  /**
   * Send alert to webhook
   */
  private async sendToWebhook(alert: Alert): Promise<void> {
    if (!this.config.webhookUrl) return;

    try {
      const payload = {
        alert: {
          id: alert.id,
          type: alert.type,
          severity: alert.severity,
          message: alert.message,
          timestamp: new Date(alert.timestamp).toISOString(),
          metadata: alert.metadata,
        },
        source: 'polymarket-copytrade-bot',
        environment: config.nodeEnv,
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.config.webhookSecret) {
        // Add HMAC signature for verification
        const crypto = await import('crypto');
        const signature = crypto
          .createHmac('sha256', this.config.webhookSecret)
          .update(JSON.stringify(payload))
          .digest('hex');
        headers['X-Signature'] = signature;
      }

      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        logger.error({ 
          status: response.status,
          alertId: alert.id,
        }, 'Webhook delivery failed');
      } else {
        logger.debug({ alertId: alert.id }, 'Webhook delivered');
      }
    } catch (error) {
      logger.error({ error, alertId: alert.id }, 'Webhook delivery error');
    }
  }

  /**
   * Send alert to email (placeholder - integrate with email provider)
   */
  private async sendToEmail(alert: Alert): Promise<void> {
    // This is a placeholder - integrate with your email provider
    // Options: SendGrid, Mailgun, AWS SES, Nodemailer, etc.
    logger.debug({ 
      alertId: alert.id, 
      to: this.config.emailTo,
    }, 'Email alert (not implemented)');
    
    // Example integration:
    // const sendgrid = require('@sendgrid/mail');
    // await sendgrid.send({
    //   to: this.config.emailTo,
    //   from: 'alerts@your-domain.com',
    //   subject: `[${alert.severity.toUpperCase()}] ${alert.type}: ${alert.message}`,
    //   text: JSON.stringify(alert, null, 2),
    // });
  }

  /**
   * Send alert to Telegram
   */
  private async sendToTelegram(alert: Alert): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) return;

    try {
      const emoji = this.getSeverityEmoji(alert.severity);
      const timestamp = new Date(alert.timestamp).toISOString();
      
      // Format message for Telegram (Markdown)
      let message = `${emoji} *${alert.severity.toUpperCase()}*\n\n`;
      message += `*Type:* ${alert.type.replace(/_/g, ' ')}\n`;
      message += `*Message:* ${this.escapeMarkdown(alert.message)}\n`;
      message += `*Time:* ${timestamp}\n`;
      
      if (alert.metadata && Object.keys(alert.metadata).length > 0) {
        message += `\n*Details:*\n`;
        for (const [key, value] of Object.entries(alert.metadata)) {
          message += `• ${key}: \`${String(value)}\`\n`;
        }
      }

      const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.telegramChatId,
          text: message,
          parse_mode: 'Markdown',
          disable_notification: alert.severity === 'info', // Silent for info alerts
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        logger.error({ 
          status: response.status,
          error: errorData,
          alertId: alert.id,
        }, 'Telegram delivery failed');
      } else {
        logger.debug({ alertId: alert.id }, 'Telegram alert delivered');
      }
    } catch (error) {
      logger.error({ error, alertId: alert.id }, 'Telegram delivery error');
    }
  }

  /**
   * Send alert to Discord via webhook
   */
  private async sendToDiscord(alert: Alert): Promise<void> {
    if (!this.config.discordWebhookUrl) return;

    try {
      const color = this.getDiscordColor(alert.severity);
      const timestamp = new Date(alert.timestamp).toISOString();
      
      // Build Discord embed
      const embed = {
        title: `${this.getSeverityEmoji(alert.severity)} ${alert.type.replace(/_/g, ' ').toUpperCase()}`,
        description: alert.message,
        color,
        timestamp,
        fields: [] as Array<{ name: string; value: string; inline: boolean }>,
        footer: {
          text: 'Polymarket CopyTrade Bot',
        },
      };
      
      // Add metadata as fields
      if (alert.metadata && Object.keys(alert.metadata).length > 0) {
        for (const [key, value] of Object.entries(alert.metadata)) {
          embed.fields.push({
            name: key,
            value: String(value),
            inline: true,
          });
        }
      }

      const payload = {
        username: 'CopyTrade Alerts',
        embeds: [embed],
      };

      const response = await fetch(this.config.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.text();
        logger.error({ 
          status: response.status,
          error: errorData,
          alertId: alert.id,
        }, 'Discord delivery failed');
      } else {
        logger.debug({ alertId: alert.id }, 'Discord alert delivered');
      }
    } catch (error) {
      logger.error({ error, alertId: alert.id }, 'Discord delivery error');
    }
  }

  /**
   * Get emoji for severity level
   */
  private getSeverityEmoji(severity: AlertSeverity): string {
    switch (severity) {
      case 'critical': return '🚨';
      case 'warning': return '⚠️';
      case 'info': return 'ℹ️';
      default: return '📋';
    }
  }

  /**
   * Get Discord embed color for severity
   */
  private getDiscordColor(severity: AlertSeverity): number {
    switch (severity) {
      case 'critical': return 0xff0000; // Red
      case 'warning': return 0xffa500; // Orange
      case 'info': return 0x00ff00; // Green
      default: return 0x808080; // Gray
    }
  }

  /**
   * Escape special characters for Telegram Markdown
   */
  private escapeMarkdown(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }

  /**
   * Check if alert type is throttled
   */
  private isThrottled(type: AlertType): boolean {
    const counter = this.throttleCounters.get(type);
    if (!counter) return false;

    const now = Date.now();
    if (now >= counter.resetTime) {
      // Reset counter
      this.throttleCounters.delete(type);
      return false;
    }

    return counter.count >= this.config.maxAlertsPerInterval;
  }

  /**
   * Update throttle counter for alert type
   */
  private updateThrottleCounter(type: AlertType): void {
    const now = Date.now();
    const counter = this.throttleCounters.get(type);

    if (!counter || now >= counter.resetTime) {
      this.throttleCounters.set(type, {
        count: 1,
        resetTime: now + this.config.throttleIntervalMs,
      });
    } else {
      counter.count++;
    }
  }

  /**
   * Check if currently in quiet hours
   */
  private isQuietHours(): boolean {
    if (this.config.quietHoursStart === undefined || this.config.quietHoursEnd === undefined) {
      return false;
    }

    const now = new Date();
    const currentHour = now.getHours();
    const start = this.config.quietHoursStart;
    const end = this.config.quietHoursEnd;

    if (start <= end) {
      return currentHour >= start && currentHour < end;
    } else {
      // Quiet hours span midnight
      return currentHour >= start || currentHour < end;
    }
  }

  /**
   * Check if alert should be sent during quiet hours
   */
  private shouldSendDuringQuietHours(severity: AlertSeverity): boolean {
    const threshold = this.config.quietHoursSeverityThreshold || 'critical';
    const severityOrder: AlertSeverity[] = ['info', 'warning', 'critical'];
    
    return severityOrder.indexOf(severity) >= severityOrder.indexOf(threshold);
  }

  /**
   * Trim alert history to prevent memory issues
   */
  private trimAlertHistory(): void {
    const maxHistory = 1000;
    if (this.alertHistory.length > maxHistory) {
      this.alertHistory = this.alertHistory.slice(-maxHistory);
    }
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.get(alertId);
    if (alert) {
      alert.acknowledged = true;
      this.emit('acknowledged', alert);
      return true;
    }
    return false;
  }

  /**
   * Get recent alerts
   */
  getRecentAlerts(count: number = 10, severity?: AlertSeverity): Alert[] {
    let alerts = this.alertHistory.slice(-count);
    
    if (severity) {
      alerts = alerts.filter(a => a.severity === severity);
    }
    
    return alerts.reverse();
  }

  /**
   * Get unacknowledged alerts
   */
  getUnacknowledgedAlerts(): Alert[] {
    return Array.from(this.alerts.values()).filter(a => !a.acknowledged);
  }

  /**
   * Get alert statistics
   */
  getStats(): {
    totalAlerts: number;
    unacknowledged: number;
    byType: Record<AlertType, number>;
    bySeverity: Record<AlertSeverity, number>;
  } {
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {
      info: 0,
      warning: 0,
      critical: 0,
    };

    for (const alert of this.alertHistory) {
      byType[alert.type] = (byType[alert.type] || 0) + 1;
      bySeverity[alert.severity]++;
    }

    return {
      totalAlerts: this.alertHistory.length,
      unacknowledged: this.getUnacknowledgedAlerts().length,
      byType: byType as Record<AlertType, number>,
      bySeverity: bySeverity as Record<AlertSeverity, number>,
    };
  }

  /**
   * Clear all alerts
   */
  clearAlerts(): void {
    this.alerts.clear();
    this.alertHistory = [];
    this.throttleCounters.clear();
  }

  // Convenience methods for common alerts

  async alertConnectionFailure(provider: string, reason: string): Promise<void> {
    await this.sendAlert(
      'connection_failure',
      'warning',
      `Connection to ${provider} failed: ${reason}`,
      { provider, reason }
    );
  }

  async alertConnectionRestored(provider: string): Promise<void> {
    await this.sendAlert(
      'connection_restored',
      'info',
      `Connection to ${provider} restored`,
      { provider }
    );
  }

  async alertDegradedMode(reason: string): Promise<void> {
    await this.sendAlert(
      'degraded_mode',
      'warning',
      `Running in degraded mode: ${reason}`,
      { reason }
    );
  }

  async alertNoEvents(durationSeconds: number): Promise<void> {
    await this.sendAlert(
      'no_events',
      'warning',
      `No events received for ${durationSeconds} seconds`,
      { durationSeconds }
    );
  }

  async alertUptimeDrop(percentage: number, threshold: number): Promise<void> {
    await this.sendAlert(
      'uptime_drop',
      'critical',
      `Uptime dropped to ${percentage.toFixed(2)}% (threshold: ${threshold}%)`,
      { percentage, threshold }
    );
  }

  async alertTradeFailure(signalId: string, reason: string): Promise<void> {
    await this.sendAlert(
      'trade_failure',
      'warning',
      `Trade execution failed: ${reason}`,
      { signalId, reason }
    );
  }

  async alertTradeSuccess(signalId: string, size: string, side: string, tokenId: string): Promise<void> {
    await this.sendAlert(
      'trade_success',
      'info',
      `Trade executed: ${side} ${size} on ${tokenId.slice(0, 18)}...`,
      { signalId, size, side, tokenId }
    );
  }

  async alertKillSwitch(reason: string): Promise<void> {
    await this.sendAlert(
      'kill_switch',
      'critical',
      `KILL SWITCH ACTIVATED: ${reason}`,
      { reason }
    );
  }

  async alertCircuitBreaker(state: string, failures: number): Promise<void> {
    await this.sendAlert(
      'circuit_breaker',
      state === 'OPEN' ? 'critical' : 'info',
      `Circuit breaker ${state}: ${failures} consecutive failures`,
      { state, failures }
    );
  }

  async alertDailyLossLimit(loss: number, limit: number): Promise<void> {
    await this.sendAlert(
      'daily_loss_limit',
      'critical',
      `Daily loss limit reached: $${loss.toFixed(2)} >= $${limit}`,
      { loss, limit }
    );
  }

  async alertBalanceWarning(balance: number, minBalance: number): Promise<void> {
    await this.sendAlert(
      'balance_warning',
      'warning',
      `Low balance warning: $${balance.toFixed(2)} approaching minimum $${minBalance}`,
      { balance, minBalance }
    );
  }

  async alertSystemStart(): Promise<void> {
    await this.sendAlert(
      'system_start',
      'info',
      'CopyTrade bot started successfully',
      { timestamp: Date.now(), environment: config.nodeEnv }
    );
  }

  async alertSystemStop(reason?: string): Promise<void> {
    await this.sendAlert(
      'system_stop',
      'warning',
      `CopyTrade bot stopped${reason ? ': ' + reason : ''}`,
      { timestamp: Date.now(), reason }
    );
  }
}

// Singleton instance
let alertServiceInstance: AlertService | null = null;

export function getAlertService(config?: Partial<AlertConfig>): AlertService {
  if (!alertServiceInstance) {
    alertServiceInstance = new AlertService(config);
  }
  return alertServiceInstance;
}

export default AlertService;
