import { defineJobHandler } from '@/platform/runtime/jobs';
import { ageingJob, rescoreAccountsJob, rescorePageJob } from './contracts/jobs';
import { ageingPage, rescoreAccounts, rescorePage } from './services/rescore';

export const rescoreAccountsHandler = defineJobHandler(rescoreAccountsJob, (e, ctx) => rescoreAccounts(ctx, e.data.accountIds, e.data.cause));

export const rescorePageHandler = defineJobHandler(rescorePageJob, (e, ctx) => rescorePage(ctx, e.data.filter, e.data.cause, e.data.afterId));

/** Nightly: signals fade with time, so accounts with a young signal are rescored. */
export const ageingHandler = defineJobHandler(ageingJob, (e, ctx) => ageingPage(ctx, e.data.afterId));
