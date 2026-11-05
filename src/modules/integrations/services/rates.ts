import { and, eq, sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { log } from '@/platform/log';
import { providerRate } from '../db/schema';
import { MAX_RATE, RATE_NEGATIVE, defaultRates, priceOf, type Rate, type UsageItem } from '../domain/rates';
import { connectionSettings, requireProvider } from './connections';

export type RateView = Rate & { isDefault: boolean };

/** R3a Ruling 1: each item the provider is priced by, the saved rate else the default. A provider with no money has none. */
export async function getRates(ctx: ModuleContext, provider: string): Promise<RateView[]> {
  requireProvider(provider);
  const defaults = defaultRates(provider, await connectionSettings(ctx, provider));
  if (defaults.length === 0) return [];
  const saved = new Map(
    (
      await ctx.tx
        .select({ item: providerRate.item, centsPerUnit: providerRate.centsPerUnit })
        .from(providerRate)
        .where(and(eq(providerRate.tenantId, ctx.tenantId), eq(providerRate.provider, provider)))
    ).map((r) => [r.item, Number(r.centsPerUnit)]),
  );
  return defaults.map((d) => {
    const s = saved.get(d.item);
    return s === undefined ? { ...d, isDefault: true } : { item: d.item, centsPerUnit: s, isDefault: false };
  });
}

const invalid = (title: string, path: string) =>
  new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path, message: title }] });

/** Saves the owner's rates for the provider's items; refuses a negative rate and an item the provider isn't priced by. */
export async function setRates(ctx: ModuleContext, provider: string, rates: readonly Rate[]): Promise<void> {
  const before = await getRates(ctx, provider);
  const items = new Set(before.map((r) => r.item));
  rates.forEach((r, i) => {
    if (!items.has(r.item)) throw invalid(`${r.item} isn't a price for this service.`, `rates.${i}.item`);
    if (!Number.isFinite(r.centsPerUnit)) throw invalid('Enter a number.', `rates.${i}.cents_per_unit`);
    if (r.centsPerUnit < 0) throw invalid(RATE_NEGATIVE, `rates.${i}.cents_per_unit`);
    if (r.centsPerUnit > MAX_RATE) throw invalid('That rate is too high.', `rates.${i}.cents_per_unit`);
  });
  if (rates.length === 0) return;
  await ctx.tx
    .insert(providerRate)
    .values(rates.map((r) => ({ tenantId: ctx.tenantId, provider, item: r.item, centsPerUnit: r.centsPerUnit, updatedBy: ctx.actor.id })))
    .onConflictDoUpdate({
      target: [providerRate.tenantId, providerRate.provider, providerRate.item],
      set: { centsPerUnit: sql`excluded.cents_per_unit`, updatedBy: ctx.actor.id, updatedAt: sql`now()` },
    });
  const changed = new Set(rates.map((r) => r.item));
  await audit(ctx, {
    action: 'integrations.rates.set',
    subject: { type: 'provider_rate', id: provider },
    before: Object.fromEntries(before.filter((r) => changed.has(r.item)).map((r) => [r.item, r.centsPerUnit])),
    after: Object.fromEntries(rates.map((r) => [r.item, r.centsPerUnit])),
  });
}

/** R3a Ruling 2: what the usage costs at the tenant's rates, in whole cents (half up). An item with no rate costs 0. */
export async function priceCents(ctx: ModuleContext, provider: string, usage: readonly UsageItem[]): Promise<number> {
  const rates = new Map((await getRates(ctx, provider)).map((r) => [r.item, r.centsPerUnit]));
  const unpriced = usage.filter((u) => u.units > 0 && !rates.has(u.item)).map((u) => u.item);
  if (unpriced.length > 0) log.warn({ provider, items: unpriced }, 'integrations: no rate for usage, priced at 0');
  return priceOf(rates, usage);
}
