// The last used workspace, remembered in this browser until the API records it (PUT /me/workspace is a gap).
const KEY = 'scout.workspace';

export function lastWorkspace(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberWorkspace(slug: string | null): void {
  try {
    if (slug) localStorage.setItem(KEY, slug);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage can be off (private windows); the app then asks the API for the landing workspace.
  }
}
