import pino from 'pino'

const level = process.env.LOG_LEVEL ?? 'info'
const pretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production'

export const log = pino(
  pretty
    ? { level, transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
    : { level },
)

export type Logger = typeof log
