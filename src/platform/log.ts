import pino, { type Logger } from 'pino';

export const log: Logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { service: 'scout' },
  redact: ['*.password', '*.secret', '*.token', '*.authorization'],
});

export function logFor(ctx: { tenantId?: string; correlationId?: string; traceId?: string }): Logger {
  const bindings: Record<string, string> = {};
  if (ctx.tenantId) bindings.tenantId = ctx.tenantId;
  if (ctx.correlationId) bindings.correlationId = ctx.correlationId;
  if (ctx.traceId) bindings.traceId = ctx.traceId;
  return log.child(bindings);
}
