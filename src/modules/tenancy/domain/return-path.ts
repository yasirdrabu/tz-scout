const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ENCODED_SEPARATOR = /%2f|%5c/i;

/**
 * Where to send someone back to after sign-in: `raw` when it is a relative in-app path (one leading
 * `/`, no `//`, no backslash, no scheme, no control characters, no encoded slash), else `/`.
 */
export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.includes('\\') || CONTROL.test(raw)) return '/';
  const path = raw.split(/[?#]/, 1)[0]!;
  if (ENCODED_SEPARATOR.test(path)) return '/';
  try {
    return new URL(raw, 'https://scout.invalid').origin === 'https://scout.invalid' ? raw : '/';
  } catch {
    return '/';
  }
}

/** The app's sign-in page, where a failed sign-in lands with `error`; it keeps a return path other than `/`. */
export function signInErrorUrl(publicUrl: string, returnPath: string): string {
  const url = new URL('/signin', publicUrl);
  if (returnPath !== '/') url.searchParams.set('return', returnPath);
  return url.toString();
}
