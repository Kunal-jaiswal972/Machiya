import { pino } from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'worker' },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});
