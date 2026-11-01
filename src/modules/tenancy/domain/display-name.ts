/** A readable name from an email: `zach.wiant@x.com` gives "Zach Wiant", `ash@x.com` gives "Ash" (never a handle). */
export function displayNameFromEmail(email: string): string {
  const local = email.trim().split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return email.trim();
  return parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join(' ');
}
