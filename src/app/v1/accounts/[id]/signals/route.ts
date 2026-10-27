import { submitArrival } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { readJson } from '../../../_lib/intake';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';
import { inlineReply, objectBody } from '../../respond';

export const dynamic = 'force-dynamic';

/** ACC-E4-S3: an inline targeted arrival with one signal. */
export const POST = v1Route({ permission: 'signals:write' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const signal = objectBody(await readJson(req));
  const r = await submitArrival(
    ctx,
    { target_account_id: id, signals: [signal] },
    { channel: 'api', inline: true, canDeclareWarmIntro: can(principal, 'warm_intro:declare') },
  );
  const url = typeof signal.url === 'string' ? signal.url.trim() : '';
  return inlineReply(r, (x) => ({
    arrivalId: x.arrivalId,
    signalId: x.signalIds[0],
    alreadyKnown: x.alreadyKnown,
    ...(url ? {} : { warning: 'A source link is strongly recommended.' }),
  }));
});
