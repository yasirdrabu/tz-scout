import { z } from 'zod';
import { defineJob } from '@/platform/events/registry';

/** Runs the resolve pipeline for one arrival. */
export const resolveJob = defineJob('intake.resolve', z.object({ arrivalId: z.string() }), { timeoutMs: 30_000 });

/** Reads an uploaded file with its confirmed mapping and submits the next chunk of companies, from `cursor` (default 0). */
export const importRunJob = defineJob('intake.import.run', z.object({ importId: z.string(), cursor: z.number().int().min(0).optional() }), { timeoutMs: 5 * 60_000 });

/** Rejects arrivals that have waited 30 days for a person. One schedule per tenant. */
export const waitingExpireJob = defineJob('intake.waiting.expire', z.object({}), {});

/** Reads contacts the CRM marked qualified since the last poll and submits each (Ruling 14). Every 15 minutes per tenant. */
export const qualifiedLeadsPollJob = defineJob('intake.qualified_leads.poll', z.object({}), { timeoutMs: 5 * 60_000 });
