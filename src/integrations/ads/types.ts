// Shared interface for ad channels (Meta first, LinkedIn optional). Google Ads is used for
// keyword data only and has its own interface.

export type AdSetInput = { statementId: string; text: string };

export type LaunchTestInput = {
  batchId: string;
  statements: AdSetInput[];
  budgetCents: number;
  durationHours: number;
  audience: { titles: string[]; industries: string[]; companySizeMin?: number | null; companySizeMax?: number | null };
  launchedAt: Date;
};

export type AdSetResult = { externalId: string; impressions: number; clicks: number; spendCents: number; complete: boolean };

export type DailyStats = { date: string; spendCents: number; impressions: number; clicks: number };

export type OfflineConversion = { dealId: string; email?: string; valueCents: number; closedAt: Date };

export interface AdChannelAdapter {
  readonly channel: "meta" | "linkedin";
  readonly mode: "mock" | "live";
  launchTest(input: LaunchTestInput): Promise<{ adSets: { statementId: string; externalId: string }[] }>;
  getResults(externalIds: string[], context: { launchedAt: Date; durationHours: number; budgetCents: number; adSetCount: number }): Promise<AdSetResult[]>;
  getDailyStats(companyKey: string, from: Date, to: Date): Promise<DailyStats[]>;
  sendConversion(c: OfflineConversion): Promise<{ accepted: boolean }>;
}
