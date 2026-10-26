// Picks mock or live per integration from env vars. The app runs end to end on mocks.

export const PROVIDERS = ["prospects", "hubspot", "meta", "linkedin", "googleAds", "companyData", "booking", "messaging", "anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ENV_KEY: Record<Provider, string> = {
  prospects: "INTEGRATION_PROSPECTS",
  hubspot: "INTEGRATION_HUBSPOT",
  meta: "INTEGRATION_META",
  linkedin: "INTEGRATION_LINKEDIN",
  googleAds: "INTEGRATION_GOOGLE_ADS",
  companyData: "INTEGRATION_COMPANY_DATA",
  booking: "INTEGRATION_BOOKING",
  messaging: "INTEGRATION_MESSAGING",
  anthropic: "INTEGRATION_ANTHROPIC",
};

export const PROVIDER_LABEL: Record<Provider, string> = {
  prospects: "Prospect data (Apollo)",
  hubspot: "HubSpot",
  meta: "Meta ads",
  linkedin: "LinkedIn ads",
  googleAds: "Google Ads",
  companyData: "Company data",
  booking: "Booking",
  messaging: "Email and SMS",
  anthropic: "Claude",
};

export function modeOf(p: Provider): "mock" | "live" {
  return process.env[ENV_KEY[p]] === "live" ? "live" : "mock";
}

/** Thrown by a live adapter whose credentials are not configured. Callers show it as "not connected". */
export class NotConnectedError extends Error {
  constructor(public provider: Provider, detail?: string) {
    super(`${PROVIDER_LABEL[provider]} is not connected${detail ? `: ${detail}` : ""}.`);
    this.name = "NotConnectedError";
  }
}

export function requireEnv(p: Provider, ...names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new NotConnectedError(p, `set ${missing.join(", ")}`);
  for (const n of names) out[n] = process.env[n]!;
  return out;
}

export function mockSeconds(): number {
  const n = Number(process.env.MOCK_AD_TEST_SECONDS ?? 20);
  return Number.isFinite(n) && n > 0 ? n : 20;
}
