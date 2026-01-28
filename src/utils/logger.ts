import pino from 'pino';
import config from '../config/index.js';

export const logger = pino({
  level: config.logLevel,
  transport: config.nodeEnv === 'development' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  } : undefined,
  base: {
    service: 'polymarket-copytrade',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createChildLogger(context: string) {
  return logger.child({ context });
}

export default logger;
