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
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]');
  return out.length > MAX ? `${out.slice(0, MAX - 1)}…` : out;
}
