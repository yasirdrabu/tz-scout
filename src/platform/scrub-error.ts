const MAX = 500;

/**
 * Makes an error message safe to store and show: URL credentials and query strings, bearer tokens,
 * Scout keys and long token-like runs are replaced, and the text is cut to 500 characters.
 */
export function scrubError(text: string): string {
  const out = text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#'"]*@/gi, '$1[redacted]@')
    .replace(/\b((?:https?|postgres(?:ql)?|nats|tls|redis|amqp):\/\/[^\s?#'"]*)\?[^\s'"]*/gi, '$1?[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bscout_(?:live|test)_[A-Za-z0-9_-]+/g, '[redacted key]')
    .replace(/(?=[A-Za-z0-9+_=]*\d)[A-Za-z0-9+_=]{32,}/g, '[redacted]');
  return out.length > MAX ? `${out.slice(0, MAX - 1)}…` : out;
}

/** Drops the `params: ...` tail Drizzle appends to failed-query messages; the values can be personal data. */
export function stripQueryParams(text: string): string {
  return text.replace(/\n?[ \t]*params:[\s\S]*$/, '');
}

/** A safe one-line description of any thrown value, for logs and dead jobs. Includes a wrapped cause. */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return scrubError(String(e));
  let text = `${e.name === 'Error' ? '' : e.name + ': '}${stripQueryParams(e.message)}`;
  // Drizzle wraps database errors; the cause carries the reason (for example a statement timeout).
  if (e.cause instanceof Error) text += ` (${stripQueryParams(e.cause.message)})`;
  return scrubError(text);
}
